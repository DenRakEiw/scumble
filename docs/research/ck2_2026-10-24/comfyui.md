# comfyui

## Summary

Scope note: this is the read-only research step. The user's own request was to write a reply to Neex. That reply is not drafted here.

What decides the design:

1. **Two ComfyUI packs run CorridorKey 2.0. Both are one or two days old and have no history.** They are marawan206/ComfyUI-CorridorKey2.0 (eeee7fa, 2026-10-22) and hashu786/ComfyUI-CorridorKey2 (141c31b, 2026-10-23). Each has 0 stars and 0 issues. Both copy upstream commit 485f5e9 unchanged and are under the CorridorKey Licence 2.0. Both take an IMAGE and an optional MASK hint (white = subject) and work on a single frame. Both return a 4-channel RGBA IMAGE: `CorridorKey2Basic.rgba` in marawan206 and `CorridorKey2.cutout` in hashu786. On first use both download about 5.1 GB into `models/corridorkey2/`, each in its own folder layout. Both need an NVIDIA RTX 30 or newer card, because the model runs in bf16 under CUDA autocast.
2. **Every other pack runs v1 (GreenFormer, about 300–400 MB).** That covers SeanBRVFX, cnoellert, pixelworldai, KoLt-Real ("V2" is only the pack's name), Mister-Link, YAK and TrentNodes. None of the CorridorKey packs is Active on the Comfy Registry; TrentNodes, which bundles a CorridorKey node, is there but every version is Flagged. ComfyUI-Manager's list holds only pixelworldai and SeanBRVFX. Two packs register the same class name `CorridorKeyKeyer` with different inputs.
3. **Comfy Cloud has no CorridorKey node** (0 of 3,835 nodes). Possible fallbacks there: `ImageMatting` (needs a trimap), `AILab_SDMatte`, the BiRefNet matting models, and VITMatte detail inside `LayerMask: BiRefNetUltra`.
4. **On Scumble's side, nothing that exists today carries CorridorKey's colour and alpha into one layer.**
   - The edit route goes through the node's stitch, which keeps only RGB and uses the selection as alpha.
   - The whole-picture route refuses any graph that reads the mask, and it replaces the base picture.
   - The cutout route returns only a mask over the layer's original pixels, so the green edges stay.
   - A dedicated helper prompt would work, built like `realism.passPrompt` or the relight route: two `InpaintCanvasLoadRef` loaders (picture, hint from `maskToCanvas`), then `ImageToMask`, the model loader and keyer, and a `PreviewImage` on the RGBA output. `comfyPictureRun` returns that PNG and it lands with `addLayer`. ComfyUI's SaveImage writes 4 channels as an RGBA PNG.
5. **Speed:** after the first load, measured on an RTX 4090 over clips: about 0.14 s per frame at 720p, 0.28 s at 1080p, and 1.2 s at 4K in low-VRAM mode. A single still carries extra overhead. Every change of the hint re-runs the whole node, foundation models included. That means seconds per update, not real time.

## Report

## Note on scope

The user's relayed request was *"schreibe ihm eine antwort ! Danke freut mich so sehr"* (write him a reply; thanks, very happy about it). This step is the read-only research the workflow assigned (the ComfyUI route and the node packs). It does not draft the reply.

Everything I read lives in the scratch folder `C:/Users/SCHOEN~1/AppData/Local/Temp/claude/F--canvas/543d44fb-4d2d-4818-8804-974916d10a44/scratchpad/ck_comfy`:
- shallow clones of 8 packs and of upstream CorridorKey2.0
- `custom-node-list.json`
- `inpaintcanvas_node/nodes.py`, taken from GitHub at 4e7bd24
- ComfyUI v0.42.4 core files in `comfy_core/`

Nothing was run. I did not touch the user's ComfyUI or F:\canvas.

---

## 0. Upstream CorridorKey 2.0: the facts the packs build on

Source: https://github.com/nikopueringer/CorridorKey2.0 at 485f5e9.

**Repository history (read):**
- The repo was created 2026-07-15 (GitHub API). Its first commit is "CorridorKey 2.0" on 2026-10-13, and it has 5 commits.
- The weights on Hugging Face (`nikopueringer/CorridorKey2.0`) were last modified on 2026-10-13.
- So CLAUDE.md's "July 2026" matches the repo's creation date. The public release was mid-October (inferred).

**Hardware and downloads (read):**
- An NVIDIA RTX 30 or newer, 4 GB of VRAM up to 1440p and 6 GB for 4K (README L21-23).
- The download is about 5 GB (README L42-49). Measured sizes through the HF API and an HTTP HEAD request:
  - `corridorkey_v2.safetensors`: 2,661,698,720 B
  - C-RADIOv4-SO400M `model.safetensors`: 1,724,986,512 B
  - MoGe-2 ViT-B normal `model.pt`: 419,110,160 B
  - RVM `pretrain_rvm_small16_256_204031069.npz`: 270,086,372 B (Google storage)
  - `foundation_stats.safetensors`: 18,864 B

**Stills (read):**
- The window choice goes "from `80/40` down to a single frame" (README L225).
- `1/1` means each frame is keyed on its own (README L246). So a still is a clip of one frame.

**Hint (read):**
- A single-channel matte or an alpha image, white = subject (README L127-129).
- `--hint_quality`: 0.95 for a clean matte, 0.75 for a rough automatic one, 0.5 or less for a loose hint (README L188-198).
- With no hint, the model decides on its own what the subject is.

**Outputs (read):**
- `alpha`, `fg` (raw straight foreground), `checker`, and `cutout`, which is despilled straight colour with alpha, sRGB by default (README L262-305).
- Despill defaults to 0.5.

**The hint does not reach the foundation models (read):**
- In `corridorkey/model.py:191-275`, C-RADIO, MoGe and RVM run on the RGB only.
- The hint first enters at Stage 1.
- So foundation features could in principle be cached across hint edits (inferred). Neither ComfyUI pack does this.

**Upstream's own dependency pins (read):** `numpy<2`, `transformers<5`, and `utils3d` from git (`requirements.txt` L1, L3, L11). Both CK2 ComfyUI packs work around these pins.

**Licence (read):**
- CorridorKey Licence 2.0 = CC BY-NC-SA 4.0 plus additional terms.
- §2(d): integrating CorridorKey into a commercial software package needs a written agreement.
- §2(b): no paid inference API.
- README L228-241.

---

## 1. ComfyUI node packs for CorridorKey

**How I searched:**
- GitHub repository search for `corridorkey` found 57 repos.
- GitHub code search for `corridorkey NODE_CLASS_MAPPINGS` found 13 files.
- Comfy Registry `api.comfy.org/nodes/search?search=corridor|corridorkey|keyer|greenscreen` returned 0 results. Direct lookups of likely ids returned "Node not found". The publishers `marawan206` and `cnoellert` list no nodes.
- ComfyUI-Manager's `custom-node-list.json` (Comfy-Org/ComfyUI-Manager, main, fetched 2026-10-24) has two entries: pixelworldai/ComfyUI-CorridorKeyWrapper and SeanBRVFX/ComfyUI-CorridorKey.

### CorridorKey 2.0 packs

**A. marawan206/ComfyUI-CorridorKey2.0** — https://github.com/marawan206/ComfyUI-CorridorKey2.0 @ eeee7fa (2026-10-22). Created and pushed the same day; 0 stars, 0 issues.

*Version, licence, distribution (read):*
- Runs v2. Upstream 485f5e9 is copied unchanged (README Credits).
- LICENSE is the CorridorKey Licence 2.0.
- `pyproject` names PublisherId `marawan206` and requires ComfyUI ≥ 0.25.0, because the pack uses the V3 `comfy_api.latest` io API. The user runs ComfyUI v0.42.4 (CLAUDE.md).
- Not on the Registry and not in Manager's list. Install is "Install via Git URL" or `git clone` (README L54-73).

*Nodes (16, all read):*
- `CorridorKey2ModelLoader`
  - inputs: `weights` (combo), `auto_download` (default true), `keep_on_gpu`, `vram_reserve_gb`
  - output: the model (a custom CorridorKey model type)
  - `nodes/model_nodes.py:32-51`
- `CorridorKey2Basic`
  - inputs: `model`, `images` (IMAGE batch), optional `alpha_hint` (MASK, white = subject), `hint_quality` (presets 0.95 / 0.75 / 0.5), `invert_hint`, `despill` (0.5), `screen`
  - outputs: `foreground` (IMAGE, straight sRGB, despilled), `alpha` (MASK), `rgba` (4-channel IMAGE)
  - `nodes/keyer_basic.py:24-72`
- `CorridorKey2Advanced`
  - inputs: the hint inputs with keyframe modes, `temporal_window` (auto … 1/1), `low_vram`, `input_colorspace` and `output_colorspace` (sRGB or linear; linear output is unclamped), `process_scale` (0.25–1, the model runs smaller and the result is scaled back up), `stage2_batch`
  - outputs: `foreground` (straight, no despill), `alpha`, `coarse_alpha`, `decision_matte`, `info`
  - `nodes/keyer_advanced.py:58-120`
- Also: `CorridorKey2HintPrep`, `CorridorKey2ChromaHint`, `CorridorKey2MatteRefine`, `CorridorKey2Despill`, `CorridorKey2Composite` (outputs `composite` and `rgba`), `CorridorKey2LoRA`, `CorridorKey2DepthNormals`, `CorridorKey2SemanticIdentity`, `CorridorKey2MotionTracking`, `CorridorKey2TemporalStability`, `CorridorKey2FineTuneBasic` / `Advanced`, `CorridorKey2DemoClip`.

*Behaviour:*
- **Single frame works (read).** `select_profile` keeps a floor of 2/1 only when the clip has more than one frame; a 1-frame clip may use 1/1 (`ck_comfy/pipeline.py:254-280`).
- Hints of any size are resized to the clip (README L174-181).
- **Polarity, a trap (read):** Load Image's MASK is 1 − alpha, so a cutout PNG's mask needs `invert_hint` (README L174-181).
- **Downloads (read):** on first use, 5.1 GB into `models/corridorkey2/`, laid out as `corridorkey_v2.safetensors` plus `foundations/{cradio,moge,rvm}`. The download resumes after an interruption. An offline copy can be made with `scripts/download_models.py` (README L80-109).
- **Dependencies (read):** `safetensors`, `einops`, `timm`, `scipy`, `opencv-python`, `huggingface_hub`. Nothing pins torch, numpy or transformers (README L75-76). `utils3d` is replaced by a shim (`ck_comfy/env.py`).
- **CUDA only (read):** without CUDA the run raises "CorridorKey 2.0 needs an NVIDIA GPU (CUDA)" (`ck_comfy/pipeline.py:657`).
- **Windows (read):** tested on Windows 11, ComfyUI 0.42.0, PyTorch 2.11, Python 3.12 and an RTX 4090. It respects the Windows commit limit (README L47-50 and L252-259).
- **Memory between runs (read):**
  - The auto window "asks ComfyUI to unload other models".
  - After each run the model moves back to system RAM unless `keep_on_gpu` is set.
  - Loading takes about 10 s.
  - README L209-217 and L389.
- **No feature cache across runs (inferred):** grep finds only the per-run `carry_cache` (`pipeline.py:440-518`).

**B. hashu786/ComfyUI-CorridorKey2** — https://github.com/hashu786/ComfyUI-CorridorKey2 @ 141c31b (2026-10-23). Created and pushed the same day; 0 stars, 0 issues.

*Version, licence, distribution (read):*
- Runs v2. Upstream 485f5e9 and MoGe are copied unchanged (README L78).
- LICENSE is the CorridorKey Licence 2.0.
- No `pyproject`. Not on the Registry or in Manager's list.

*Nodes (read):*
- `CorridorKey2`
  - required inputs: `image` (IMAGE; the batch is one clip), `gamma_space` (sRGB / Linear), `hint_quality`, `carry_hint`, `carry_hint_quality`, `despill_strength` (0.5), `window` (auto, 80/40 … 1/1), `low_vram`, `unload_other_models` (default **true**)
  - optional input: `mask` (MASK). One mask is a first-frame hint, one per frame a full hint video; any other count is an error.
  - outputs: `RETURN_TYPES ("IMAGE","MASK","IMAGE","IMAGE","IMAGE")`, named `fg` (straight, no despill), `matte`, `processed` (despilled, premultiplied in linear light), `QC` (checker, sRGB), `cutout` (RGBA, despilled straight colour; "Save Image writes a transparent PNG")
  - Outputs keep the input's colour space.
  - Only connected outputs are computed.
  - `nodes.py:100-158`; README L11-33.
- `CorridorKey2RenderToDisk`: input paths, output EXR or video (`nodes.py:170-248`).
- **Single frame (inferred):** it uses upstream's `apply_auto_vram`, which goes down to 1/1 (`corridor_key2/processor.py:364`; upstream README L225).

*Behaviour (read):*
- Downloads about 5 GB automatically into `models/corridorkey2/{weights,vfms}`, a different layout from pack A. `extra_model_paths.yaml` can point elsewhere; `CORRIDORKEY2_NO_DOWNLOAD=1` turns the download off (README L55-74).
- Dependencies: `opencv-python`, `transformers>=4.57`, `timm`, `safetensors>=0.6`, `huggingface-hub>=0.36`, `einops`, `scipy`, `pillow`, `tqdm`. No upper pins; `utils3d` is stubbed.
- RTX 30 or newer; a 1080p clip fits in about 6 GB.
- Install instructions for the Windows portable build are given.
- The model is offloaded to the CPU after each run.

### CorridorKey 1.0 packs (GreenFormer, 2048² inference)

**C. KoLt-Real/ComfyUI-CorridorKeyV2** — @ bb3bb95 (2026-08-20). Licence: CorridorKey Licence 1.0.
- **Version (read):** v1 only. "V2" is the pack's name; its checkpoints are `CorridorKey_v1.0` and `CorridorKeyBlue_1.0` (`pipeline/prepare.py:20-23`).
- **Nodes (read):**
  - `CorridorKeyModelLoader`: `screen_color`, `precision` (fp16/fp32), `refiner` (full / tiled / off), `torch_compile`
  - `CorridorKeyKeyer`
    - inputs: `model`, `image`, `refiner_scale`, `input_is_linear`, optional `mask` (no mask means an automatic BiRefNet hint)
    - outputs: `alpha` (MASK), `fg_srgb` (IMAGE)
    - `nodes/keyer.py:24-25`
  - Also: alpha hint (BiRefNet), despeckle, despill, `premult_linear` / `comp_srgb`, colour-space nodes.
- **Frames and size (read):** frame by frame; a mask batch of 1 is broadcast. Any input size is squeezed into the 2048² window.
- **Downloads (read):** about 300 MB per screen colour into `models/corridorkey`, plus BiRefNet into `models/birefnet`.
- **VRAM (read):** 2.98 GB in fp16 with the full refiner; 1.46 GB tiled (README L85-93).
- **Distribution (read):** not on the Registry.

**D. cnoellert/comfyui-corridorkey** — @ efbf2dd (2026-05-24).
- **Licence (read):** no LICENSE file; `pyproject` says "CC BY-NC-SA 4.0".
- **Version (read):** v1.
- **Nodes (read):**
  - `CK_ModelLoader` → `CK_MODEL`
  - `CK_Keyer`
    - inputs: `model`, `image`, `alpha_hint` (MASK, **required**), `input_is_linear`, `despill_strength` (1.0), `auto_despeckle`, `despeckle_size` (400), `refiner_strength`
    - outputs: `foreground` (sRGB straight), `alpha` (MASK), `processed`
  - Also: `CK_Despill`, `CK_Despeckle`, `CK_LinearToSRGB`, `CK_SRGBToLinear`
  - `nodes/keyer.py:14-31`
- **Install (read):** `install.py` pip-installs upstream from git with `--no-deps` (`install.py:17-29`). The 383 MB `.pth` is downloaded by hand.
- **Hardware (read):** about 23 GB of VRAM at 2048; CUDA, MPS or CPU (README L46-74).

**E. SeanBRVFX/ComfyUI-CorridorKey** — @ 0f724f7 (2026-03-02). In Manager's list.
- **Licence (read):** a custom "License Notice" file (GitHub reports NOASSERTION).
- **Version (read):** v1.
- **Node (read):** `CorridorKey`
  - inputs: `image`, `mask` (required, one per frame), `gamma_space`, `despill_strength`, `refiner_strength`, `auto_despeckle`, `despeckle_size`
  - outputs: `fg`, `matte` (MASK), `processed` (linear premultiplied RGB), `QC`
- **Model (read):** no download; the `.pth` goes into the pack's own `models/` folder.
- **Network at import (read):** a background thread calls the GitHub API to check for upstream commits (`corridor_key/upstream_sync.py:14,125,192`).

**F. pixelworldai/ComfyUI-CorridorKeyWrapper** — @ 7eb44e4 (2026-05-04). In Manager's list.
- **Licence (read):** no LICENSE file; the README cites the Corridor licence.
- **Version (read):** v1.
- **Nodes (read):**
  - `LoadCorridorKeyModel`
  - `CorridorKeyGreenscreen`
    - inputs: `ck_model`, `image`, `alpha_hint` (required), optional despill and refiner settings, `input_is_linear`
    - outputs: `alpha` (MASK), `foreground`, `processed_rgba`, `comp_preview`
  - `ChromaKeyPrepass`, `CorridorKeyComposite`
- **Install at run time (read):** if upstream is missing, the loader runs `pip install` of it from git (`nodes/load_model.py:90-102`). The checkpoint downloads automatically.

**G. Mister-Link/ComfyUI-CorridorKey** — @ 6eb7a5b (2026-08-21).
- **Licence (read):** CC BY-NC-SA 4.0.
- **Version (read):** v1.
- **Nodes (read):**
  - `CKL_ModelLoader`
  - `CKL_Keyer`: **no mask input**; it makes its own mask (HSV, BiRefNet-ONNX, or hybrid). Outputs `composite`, `alpha`, `foreground`, `processed` (`nodes/keyer.py:44-61`).
- **Dependencies (read):** needs `onnxruntime-gpu`. Checkpoints are downloaded by hand.

**H. Ahmed791996/ComfyUI-YAK** — @ 1ba26a2 (2026-06-10).
- **Licence (read):** none.
- **Version (read):** v1, inside a pack of many tools.
- **Node (read):** `MaskKey_Green` (images, optional `alpha_hint`) → `rgb`, `alpha` (IMAGE), `mask`, `success`, `log`.
- **Dependencies (read):** pulls upstream, ml-sharp and MatAnyone from git, pins `imageio==2.25.0`, and adds aiohttp routes. Heavy.

**I. TrentHunter82/TrentNodes** — MIT.
- **Distribution (read):** on the Registry as `trentnodes`; every version through 1.21.1 is **Flagged** (Registry API). Its keyer was added in 67cb512 on 2026-03-26.
- **Version (read):** v1, `CorridorKey_v1.0.pth`, img_size 2048.
- **Node (read):** class `CorridorKeyKeyer`, which **clashes** with pack C's class of the same name.
  - inputs: `images`, `mask`, `bg_color`, `background_images`, `refiner_scale` …
  - outputs: `composite`, `alpha_matte`, `foreground`
- **Telling the packs apart (inferred):** Scumble would have to identify the pack by `/object_info`'s `python_module` (ComfyUI `server.py:855` at v0.42.4) or by the input spec, not by the class name.

**Not applicable:** wee-todd/WeeTodd-Studio uses `corridorkey_mlx` and runs on Apple only (read). I did not read ethanhubin/ermbg.

---

## 2. Comfy Cloud

Checked read-only through the Comfy Cloud MCP. The live catalog had 3,835 nodes, refreshed 2026-10-24T11:53Z. No job was submitted.

**No CorridorKey node (read):**
- `search_nodes q=corridor` returned 0.
- `get_node` for `CorridorKey2Basic`, `CorridorKey2`, `CorridorKey`, `CK_Keyer`, `CorridorKeyKeyer` and `CorridorKeyGreenscreen` returned all six as missing.
- "green screen" and "chroma key" found only `BriaVideoGreenScreen`, a partner video node.
- "despill", "trimap" and "vitmatte" returned 0.
- CLAUDE.md says Comfy Cloud takes no custom nodes (item 35).
- CK2's licence §2(b) forbids paid inference, so an offering on Comfy Cloud would need Corridor's agreement (inferred).

**Possible fallbacks on Comfy Cloud (read):**
- `ImageMatting` (ComfyUI-Image-Filters)
  - inputs: `images`, `trimap` (MASK, required), `preblur` (8), `blackpoint`, `whitepoint`, `max_iterations`, `estimate_fg`
  - outputs: MASK, IMAGE, IMAGE
  - I assume `estimate_fg` returns a foreground estimate; not checked (unverified).
- `AILab_SDMatte` (comfyui-rmbg)
  - inputs: `image`, `model` (SDMatte / SDMatte_plus), `process_res` (1024, up to 2048), optional `mask` (white = foreground), `mask_refine`, …
  - outputs: IMAGE, MASK, IMAGE
- `BiRefNetRMBG`, including the BiRefNet-matting, HR-matting and lite-matting models.
- `RMBG` (RMBG-2.0, INSPYRENET, BEN, BEN2).
- `LayerMask: BiRefNetUltra` and `UltraV2`, with VITMatte or PyMatting detail.
- Core `RemoveBackground` and the subgraph `remove_background_birefnet`.
- Partner nodes `BriaGuidedRemoveBackground` and `RecraftRemoveBackgroundNode`.
- Core `JoinImageWithAlpha`.

None of these removes spill or unmixes colour the way CorridorKey does (inferred).

---

## 3. Scumble's side: can a local recipe send picture plus hint and get one RGBA layer back?

The short answer: not through any route that exists today. One new helper route built from existing parts would do it.

**The edit route fails** (an `InpaintCanvas` recipe whose `crop_mask` is wired to the hint):
- The node's `InpaintCanvasStitch` keeps RGB only: `src = result[0:1, :, :, :3]` (DenRakEiw/ComfyUI-InpaintCanvas `nodes.py:873-874` @ 4e7bd24).
- It writes the layer's alpha as the feathered selection mask (`nodes.py:921`).
- So CorridorKey's alpha would be thrown away (read).

**The whole-picture route fails** (`comfyprompt.wholePicturePrompt`):
- It refuses any graph that reads more than slot 0 of the canvas node, the mask included (`renderer/editor/comfyprompt.js:57-71`, the filter at L65).
- Its answer becomes the new base through `landWholePicture` (`renderer/editor/host.js:2346`).
- docs/RECIPES.md:1396 says "The loader gives RGB, so a cut-out picture comes back opaque" (read).

**The cutout route works only halfway:**
- `CUTOUT_BACKENDS` builders take only the loader's id: `build: (load) => …`, plus `maskOut` (`renderer/editor/inpaint_canvas.js:1257-1305`).
- `cutoutLayer` sends LoadRef, then the backend, then `InpaintCanvasMaskOut` with purpose "cutout" (`inpaint_canvas.js:16332-16366`).
- `applyCutoutImage` turns the mask's R channel into the layer's **transparency mask** and leaves the pixels unchanged (`inpaint_canvas.js:16386-16419`).
- So a CorridorKey backend there would add alpha with no extra machinery. But the hint could not be passed, and CorridorKey's unmixed colour would be lost, leaving green edges (read and inferred).

**A dedicated helper prompt would work. It follows two existing patterns:**
- `realism.passPrompt`: `InpaintCanvasLoadRef`, then the pack's nodes, then a `PreviewImage` named `rp_out` (`renderer/editor/realism.js:470-481`).
- The relight route on ComfyUI: a recipe graph whose `canvas` is swapped for LoadRef, with `PreviewImage` "relight_out" (`renderer/editor/host.js:3697-3741`).

**The parts that already exist (read):**
- `comfyPictureRun(editor, prompt, outputId, {timeoutMs, deadline, token, front})`: queues the prompt, waits, and returns `{bytes, mime, seconds}` of the output node's first image (`host.js:3025-3137`).
- `uploadInput` (`host.js:2989`) and `uploadResult` (`host.js:2778`).
- `maskToCanvas()`: turns the selection into an opaque grey RGB canvas, white = selected, i.e. white = subject (`inpaint_canvas.js:22689-22701`).
- `InpaintCanvasLoadRef` loads RGB only (`nodes.py:949-975`, `_load_rgb` at `nodes.py:164-175`). So the hint goes as a grey PNG through core `ImageToMask` with channel red (ComfyUI v0.42.4 `comfy_extras/nodes_mask.py:149`).
- ComfyUI's `SaveImage`/`PreviewImage` writes a 4-channel IMAGE as an RGBA PNG: `Image.fromarray(...)` (ComfyUI v0.42.4 `nodes.py:1708`; `PreviewImage(SaveImage)` at L1730).
- Landing as a new layer, the way `realismWhole` does it: `bytesToImage` (`host.js:3484`), then `pixels.Layer.fromImage` (`host.js:3519`), then `editor.addLayer({kind:"image", ...})` (`host.js:3554`).
- Readiness checks to reuse:
  - `realism.serverSupport` checks the GPU generation from `/system_stats` and that the nodes are in `objectInfo` (`realism.js:94-127`).
  - `host.nodeTypes()` and `loadObjectInfo()` are at `host.js:1283-1295`.

**A sketch graph (inferred):**
- `ck_in` = `InpaintCanvasLoadRef{ref: picture}`
- `ck_hint_img` = `InpaintCanvasLoadRef{ref: hint}`, then `ck_hint` = `ImageToMask{channel:"red"}`
- `ck_model` = `CorridorKey2ModelLoader{auto_download:false?}`
- `ck_key` = `CorridorKey2Basic{images, alpha_hint, hint_quality, despill, screen}`
- `ck_out` = `PreviewImage{images:[ck_key, 2]}`, i.e. the `rgba` output
- With pack B instead: `CorridorKey2{...}` with `ck_out` on `cutout`, slot 4.
- Avoid `JoinImageWithAlpha` for this job: it inverts the mask (`1.0 - alpha`, `nodes_compositing.py:207`).

**What is missing (inferred):**
1. A host method, a command and the UI for keying. No `task` type fits: recipes know `edit | upscale | pass | relight` (`electron/main/recipes.js:138`, `594-602`).
2. `withSpecDefaults` is a private function in `inpaint_canvas.js:1046-1064`, not in `comfyprompt.js` as the task text assumed. host.js would need it exported or copied.
3. **Precision at the edges:** `Layer.fromImage` draws through a 2D canvas (`renderer/editor/inpaint_tiles.js:797-804`), which premultiplies. Straight colour at low alpha gets quantised. Two ways round it, both new:
   - two answers, an opaque foreground and a grey alpha, joined with `writeRect` in the app — but `comfyPictureRun` reads only one output node;
   - or a straight PNG decode in the app.
4. **Size:** both packs key at native resolution (pack A's Basic node has no `process_scale`). A 15k picture should go as the selection's box plus a margin.
5. **First run:** the loader downloads 5 GB inside the run. `comfyPictureRun`'s default timeout is 300 s. Pack A's `auto_download:false` fails fast and names the missing files (README L378-379).
6. **Effect on the user's other models:** pack B's `unload_other_models` (default true) and pack A's auto window evict the user's loaded models before a key (read).
7. **Pack identity:** check `python_module`, because of the `CorridorKeyKeyer` name clash.

---

## 4. Time per still on a local ComfyUI

**Measured by pack A (read)** — RTX 4090, model already loaded, clips with a first-frame hint (README L219-236):

| Resolution | Window | Low-VRAM | s/frame | Peak VRAM |
|---|---|---|---|---|
| 720p | 80/40 | off | 0.14 | 12.4 GB |
| 720p | 8/4 | off | 0.13 | 5.5 GB |
| 1080p | 24/12 | off | 0.27 | 10.9 GB |
| 1080p | 8/4 | on | 0.28 | 4.0 GB |
| 4K | 8/4 | on | 1.17 | 9.1 GB |
| 4K at `process_scale` 0.5 | whole clip | off | 0.29 | 10.9 GB |

Other costs from pack A's README:
- Loading the model takes about 10 s.
- The first run also downloads about 5 GB.
- The model returns to system RAM after each run unless `keep_on_gpu` is set.

**Pack C, v1 (read):** 1.17 s per frame at 1024² input with 2048² processing on an RTX 4090 Laptop. The first `torch.compile` takes about 8 minutes (README L85-93).

**What this means for a still (inferred):**
- A still pays these per-frame figures without a clip to spread the fixed costs over.
- Compute is probably about 0.3–1.5 s up to 4K on the user's RTX 5090.
- On top come:
  - moving 4.6 GB of weights from RAM to the GPU after the offload (unless `keep_on_gpu`)
  - the PNG upload and download
  - the queue, including waiting behind the user's own jobs
- **Every hint change re-runs the whole node, foundations included.** No pack caches features across runs, and ComfyUI's cache only hits on identical inputs. That gives about 1–3 s or more per update, not the "real time" hint Neex described. Neex probably meant Corridor's own tools (unverified).
- corridorkey.com (fetched) gives no speed figures and does not mention painting a hint.

---

## Sources

- https://github.com/nikopueringer/CorridorKey2.0 (485f5e9); HF API for nikopueringer/CorridorKey2.0, CorridorKey_v1.0, nvidia/C-RADIOv4-SO400M, Ruicheng/moge-2-vitb-normal
- The pack repositories at the commits above; https://api.comfy.org/nodes/search; https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/main/custom-node-list.json
- https://github.com/DenRakEiw/ComfyUI-InpaintCanvas/blob/4e7bd24/nodes.py
- https://github.com/comfyanonymous/ComfyUI/tree/v0.42.4 (`nodes.py`, `comfy_extras/nodes_compositing.py`, `comfy_extras/nodes_mask.py`, `server.py`)
- https://corridorkey.com; [CorridorKey by LateNite release notes](https://corridorkeybylatenite.fcp.cafe/release-notes/), [Beeble CorridorKey](https://beeble.ai/models/corridor-key) (search results only, v1)

## Facts

- [read] Exactly two ComfyUI packs run CorridorKey 2.0: marawan206/ComfyUI-CorridorKey2.0 (eeee7fa, 2026-10-22) and hashu786/ComfyUI-CorridorKey2 (141c31b, 2026-10-23). Each was created the same day it was pushed and has 0 stars and 0 issues. (GitHub search and repos API; clones in the scratch folder ck_comfy)
- [read] Both CK2 packs copy upstream CorridorKey2.0 at commit 485f5e9 unchanged and carry the CorridorKey Licence 2.0. (marawan206 README Credits; hashu786 README L78; LICENSE files)
- [read] marawan206's CorridorKey2Basic takes model, images (IMAGE), an optional alpha_hint (MASK, white = subject), hint_quality, invert_hint, despill (0.5) and screen. It outputs foreground (straight sRGB, despilled), alpha (MASK) and rgba (a 4-channel IMAGE). (marawan206 nodes/keyer_basic.py:24-72)
- [read] hashu786's CorridorKey2 node returns (IMAGE, MASK, IMAGE, IMAGE, IMAGE), named fg, matte, processed, QC, cutout. cutout is RGBA (despilled straight colour plus alpha). The mask input is optional. unload_other_models defaults to true. (hashu786 nodes.py:61-140; README L11-33)
- [read] marawan206 lets a 1-frame clip use a 1/1 window; the floor of 2/1 applies only when the clip has more than one frame. (marawan206 ck_comfy/pipeline.py:254-280)
- [read] Upstream CK2 can key each frame on its own with a 1/1 window, and the automatic choice goes down to a single frame. (CorridorKey2.0 README L225, L246 @485f5e9)
- [read] The CK2 download totals about 5.07 GB: corridorkey_v2.safetensors 2,661,698,720 B; C-RADIOv4 model.safetensors 1,724,986,512 B; MoGe-2 model.pt 419,110,160 B; RVM npz 270,086,372 B. (Hugging Face API (blobs=true); HTTP HEAD on storage.googleapis.com)
- [read] Both CK2 packs download the weights automatically on first use into models/corridorkey2/, in different folder layouts. (marawan206 README L80-92; hashu786 README L55-74)
- [read] CK2 runs in bf16 under CUDA autocast. marawan206 raises an error without CUDA, and both CK2 packs require an RTX 30-series or newer card. (corridorkey/runtime.py:337; marawan206 ck_comfy/pipeline.py:657; hashu786 README L52)
- [read] In CK2 the foundation models (C-RADIO, MoGe, RVM) run on RGB only; the hint first enters at Stage 1. (CorridorKey2.0 corridorkey/model.py:191-275)
- [inferred] Neither CK2 pack caches foundation features across runs, so every hint change re-runs the whole model. (grep of marawan206 pipeline.py (only the per-run carry_cache, L440-518) and the hashu786 processor)
- [read] marawan206 measured on an RTX 4090, model loaded: 720p 0.13-0.14 s/frame, 1080p 0.27-0.28 s/frame, 4K 1.17 s/frame (8/4 low-VRAM), 4K at process_scale 0.5 0.29 s/frame. Loading the model takes about 10 s; after each run the model moves back to system RAM unless keep_on_gpu is set. (marawan206 README L209-236, L389)
- [read] KoLt-Real/ComfyUI-CorridorKeyV2 runs CorridorKey v1 (checkpoints CorridorKey_v1.0 / CorridorKeyBlue_1.0) despite its name; fp16 with the full refiner peaks at 2.98 GB and runs 1.17 s/frame at 2048² processing. (KoLt-Real pipeline/prepare.py:20-23; README L85-93)
- [read] No CorridorKey pack shows up in Comfy Registry search; TrentNodes (which includes a v1 CorridorKeyKeyer) is on the Registry with every version Flagged. (api.comfy.org/nodes/search and /nodes/trentnodes/versions)
- [read] ComfyUI-Manager's custom-node-list.json lists only pixelworldai/ComfyUI-CorridorKeyWrapper and SeanBRVFX/ComfyUI-CorridorKey for CorridorKey. (Comfy-Org/ComfyUI-Manager main custom-node-list.json, fetched 2026-10-24)
- [read] KoLt-Real and TrentNodes both register the class name CorridorKeyKeyer, with different inputs. (KoLt-Real nodes/keyer.py NODE_CLASS_MAPPINGS; TrentNodes nodes/corridorkey_keyer.py)
- [read] Comfy Cloud's catalog (3,835 nodes, 2026-10-24) has no CorridorKey node; the green-screen search finds only BriaVideoGreenScreen. (Comfy Cloud MCP search_nodes / get_node)
- [read] Comfy Cloud has matting fallbacks: ImageMatting (needs a trimap; estimate_fg), AILab_SDMatte (optional mask), BiRefNetRMBG matting models, RMBG/BEN2, LayerMask BiRefNetUltra with VITMatte, and core RemoveBackground. (Comfy Cloud MCP search_nodes / get_node)
- [read] InpaintCanvasStitch keeps only the result's RGB and writes the layer's alpha from the feathered selection mask, so an edit recipe would discard CorridorKey's alpha. (DenRakEiw/ComfyUI-InpaintCanvas nodes.py:873-874, 921 @4e7bd24)
- [read] InpaintCanvasLoadRef returns a 3-channel RGB IMAGE; PIL drops the alpha. (ComfyUI-InpaintCanvas nodes.py:164-175, 949-975 @4e7bd24)
- [read] wholePictureRefusal refuses any recipe graph that reads more than slot 0 of the canvas node (its crop_mask included). (F:\canvas\renderer\editor\comfyprompt.js:57-71)
- [read] The cutout route applies only the returned mask's R channel as the layer's transparency mask and leaves its pixels unchanged; cutout backends are built from the loader id alone, with no hint. (F:\canvas\renderer\editor\inpaint_canvas.js:1257-1305, 16332-16366, 16386-16419)
- [read] withSpecDefaults lives (unexported) in inpaint_canvas.js, not in comfyprompt.js. (F:\canvas\renderer\editor\inpaint_canvas.js:1046-1064)
- [read] comfyPictureRun queues any API prompt and returns the first image of one named output node as {bytes, mime, seconds, promptId}. (F:\canvas\renderer\editor\host.js:3025-3137)
- [read] realism.passPrompt (LoadRef -> pack nodes -> PreviewImage) and the relight route on ComfyUI are the existing models for a CorridorKey helper prompt. (F:\canvas\renderer\editor\realism.js:470-481; host.js:3697-3741)
- [read] maskToCanvas turns the selection into an opaque grey RGB canvas (selected = white), usable as a hint through LoadRef plus ImageToMask (red channel). (F:\canvas\renderer\editor\inpaint_canvas.js:22689-22701; ComfyUI v0.42.4 comfy_extras/nodes_mask.py:149)
- [read] In ComfyUI v0.42.4, SaveImage/PreviewImage write a 4-channel IMAGE as an RGBA PNG; JoinImageWithAlpha inverts its mask (1 - alpha). (ComfyUI v0.42.4 nodes.py:1708, 1730; comfy_extras/nodes_compositing.py:207)
- [inferred] A helper graph of LoadRef(picture) + LoadRef(hint) -> ImageToMask -> CorridorKey2ModelLoader -> CorridorKey2Basic -> PreviewImage(rgba), run through comfyPictureRun and landed with addLayer, would give one RGBA layer without node changes. (combination of the reads above)
- [inferred] Landing through pixels.Layer.fromImage draws via a 2D canvas, so straight colour at low alpha gets quantised by premultiplication. (F:\canvas\renderer\editor\inpaint_tiles.js:797-804 plus the Chromium canvas behaviour)
- [read] Corridor's site gives no speed figures for still images and does not mention painting a hint in real time. (https://corridorkey.com (WebFetch 2026-10-24))
- [read] The CK2.0 repo was created 2026-07-15; its first commit ("CorridorKey 2.0") and the Hugging Face weights are from 2026-10-13. (GitHub repos/commits API; HF API lastModified)

## Open questions

- Is either CK2 pack (marawan206 or hashu786) already installed on the user's ComfyUI? Not checked: the production server and its folders were left alone. Installing one is the user's call.
- Which CK2 pack should Scumble target? marawan206 has a separate loader with auto_download and keep_on_gpu, a Basic and an Advanced keyer (process_scale) and an rgba output. hashu786 is a single node with a cutout output and unload_other_models defaulting to true. Both are a day old, so maintenance is unknown.
- Does a 1-frame CK2 run fit in memory, and how long does it take on the user's RTX 5090 at typical selection sizes (1–4K) and at 15k? No still-image timing is published.
- Should the result land with full colour precision (two answers, opaque foreground plus grey alpha, joined with writeRect, which needs comfyPictureRun to read two outputs or a second run) or as one RGBA PNG through Layer.fromImage, which loses precision at low alpha?
- Did Neex's 'alpha hint works in real time' refer to Corridor's own plugin or app? No ComfyUI pack keeps foundation features between runs, so a ComfyUI route re-runs everything on each hint change.
- Does ImageMatting's estimate_fg on Comfy Cloud give a usable foreground colour as a cloud fallback? Its source was not read.
- Does the hint send the selection as it is, or grown or eroded first? CK2 advises hint_quality 0.95 for a clean matte and 0.5 or less for loose hints; Scumble's selection may be feathered.
