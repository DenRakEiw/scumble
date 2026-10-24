# CorridorKey 2.0 in Scumble: the build plan (item 49)

**Status: planned 2026-10-24 against `ec1142b` (branch `wasm-kernels`; `main` = 0.1.51 at `2d9a353`); re-planned the
same day after the user's answers (in-app first, a `corridorkey` branch off `main`, 0.1.52, pack A after a code check,
the grey Fill layer), then critic-checked a second time (feasibility and the rules, 41 findings: every must and should
folded in, the nice ones where they cost a line; the code anchors of every finding re-read). Nothing built.**
This file turns the research of 2026-10-24 (five read-only readers: CK2's pipeline from source, the licences, the
in-app ONNX feasibility, the ComfyUI packs, Scumble's own anchors), three designs (ComfyUI first, in-app first, the
user's flow), two critiques of them (feasibility; the user's rules) and the user's four answers into sessions. Every
defect the critics found is folded in. Every effort figure is **inferred, not measured**. Every line number is from
`ec1142b`; grep the name before editing. Facts are **read** unless marked **inferred** or **unverified**. This plan may
name other products and packs (the rule of 2026-09-29 covers CLAUDE.md, the posts, the CHANGELOG, the manual and the
README); the app's texts say "CorridorKey 2.0" only where they are about running it.

## 0. The record

**The user (2026-10-24):** "wir haben das ok von corridor crew, können es integrieren ^^ aber dann v2 ^^". Before that
(item 49, CLAUDE.md): "können wir das auch für images nehmen?", "evtl im nächsten update", and on v2 on stills: "das
müssten wir prüfen". **The user's answers of 2026-10-24** (AskUserQuestion, recorded in full in §6): **in-app first**
(against this plan's first recommendation of ComfyUI first), a branch **`corridorkey` off `main`** released as
**0.1.52** on the user's word, **pack A on the production ComfyUI after a code check**, and **a mid-grey Fill layer**
under a key of the base. Choosing in-app first is the user's yes to the spike's 2.4 GB test download (Nucito's fp16
set into a scratch folder). The user's standing rule holds: a mechanism is measured before anything is built on it, so
the spike (I0b) comes before any app code of the engine.

**Corridor's answer, verbatim (Neex, Corridor's help Discord, 2026-10-24, pasted by the user; a screenshot of it is
worth keeping outside Discord):**

> Hi there! Here's the guiding rule when it comes to distributing CK2.0 in other software- as long as the software is
> free, you may implement CK2.0 (and 1.0) however you like. So based on what you describe above, you should be totally
> fine. And if you were to sell a commercial version of your software in the future, just get in touch with us so we
> can implement some sort of agreement. As for processing stills, CK2.0 is great, and the alpha hint also works in real
> time, so you can see pretty instant results as you paint or sketch an alpha hint.

**What it covers** (read against the licence, §3): the "commercial software integration" clause (§2(d)) and the
"competing product" worry (§2(a)) for a free Scumble, the free Store copy included; the users' own commercial use of
the keyed pictures was allowed by §1 anyway. A paid Scumble edition, a "Pro" tier or Store-mediated money would need
their agreement first (CLAUDE.md already says so beside the lawyer check).

**What is still to be confirmed in writing** (the questions in §3.4; the user sends them, as a reply in the same thread
that states the scope or an email to contact@corridordigital.com): whether Scumble's own code that drives CK2.0 may be
GPL-3.0 while the weights stay under their licence; **whether a converted copy of the weights (ONNX, fp16) may be
hosted**, or whether they publish an official export; how they want to be credited; the US $20M seat clause as it
reaches Scumble's users; what "the alpha hint works in real time" refers to (no public CK2 code has a live hint; §2).
The thank-you reply the planning session drafted for the user in chat on 2026-10-24 (its second version; not the
draft quoted in `licences.md` §1) asks **1-3 and 5** in short form (GPL-3.0 for our glue, hosting an ONNX conversion or
an official export, the credit, and what the real-time hint runs in and at what resolution), **not 4** (the seat
sentence), 6 or 7. Whether it was sent, and which version, is a fact the user confirms (§6); 4, 6 and 7 (and whatever
is still unanswered) go after Stop A. **What depends on the answers:** the spike (I0b) and the engine's build (I1-I7)
depend on none of them (a test download in a scratch folder, a local export, a local test host); **the release of the
in-app route depends on answer 2** (a hosted converted set, or an official export to point at). If Corridor has not
answered in writing by Stop B, Scumble hosts nothing; what 0.1.52 ships then is **the user's decision at Stop B** (§6:
Route B built for 0.1.52, about four more days; wait for the answer; or release with the in-app rows hidden. Recommended:
Route B), and the in-app route follows in a later release once the answer is there (§4.3).

## 1. What the user gets, and how pixels land

**The behaviour in one sentence (the say-behaviour-first rule; repeated in chat before I4 and I5):** *Key green / blue
screen* adds one new layer directly above the layer or picture you key: its pixels are the subject's own colour with
the green or blue spill taken out, its layer mask is the matte CorridorKey 2.0 pulled **inside Scumble on your GPU** at
a working size and refined against the full-resolution picture, the layer is trimmed to the matte's box; when the
source is a layer, that layer is hidden in the same step, when it is the base picture a mid-grey Fill layer goes between
the base and the key in the same step so the key is visible at once; nothing else changes, and one Ctrl+Z takes it all
back. While the Key dialog is open, the matte follows the selection brush and the quick mask as you paint, and every
other selection change at its end, re-keyed at the working size and shown on the canvas (screen only, never in the
picture) in the time the spike measured end to end (§4.2; well under a second is the aim).

What a person does and sees:

1. Opens a green-screen photo (the base), or has a *Generate* result of a subject on flat green as a layer. Optionally
   selects the subject roughly: the selection brush, the quick mask (Q), a wand click, a SAM click, *Select by text*.
   No selection is fine: the model picks the subject itself.
2. *Image › Key Green / Blue Screen...*. A dialog of the app's own: **Screen** Auto / Green / Blue; **Hint** From the
   selection with its trust (Rough 0.5 / Automatic 0.75 / Clean 0.95) or None; **Despill** 0.5; **Source** the visible
   picture or the active layer; **Preview** on; a line saying what goes ("the selection's box, 3,210 × 4,100, keyed at
   803 × 1,024 and refined against the full picture"); the readiness line (the provider the engine runs on, or what
   is missing); *Key*.
3. With Preview on, the matte of the first pass appears over the canvas within seconds (the engine's first run loads
   the models and computes the picture's features once); the overlay follows the selection brush as it paints (each
   dab's hint re-keys stage 1 + 2 on cached features) and every other selection change at its end. The person paints
   until the hair and the edges look right, then *Key*.
4. A new layer **Key** lands above the source with a layer mask. The screen is gone; hair and motion blur keep their
   soft edges; the colour is unmixed, so there is no green fringe. Status: "Key: 38 % of the box kept, in 2.4 s in
   Scumble (CorridorKey 2.0 on DirectML, green screen, hint from the selection; keyed at 1,024 px, refined)."
5. Fixing edges: the mask is an ordinary layer mask (*Show alone*, P / E, `set_mask`). The Key dialog opened with a
   key layer active offers *Re-key with this layer's mask* (the painted mask as a clean hint, the engine redoes hair
   and blur from the correction, seconds; with Preview on, each mask stroke's end shows the new matte). After a
   restart the key's record is gone (it is not stored in the document, §4.5), so Re-key starts from the layer's bounds
   and the dialog says so.
6. A background under it (a Paint layer, a *Generate new* result, a loaded image placed under the key layer, or the
   grey Fill layer recoloured or replaced); colour match with source "underneath" if wanted; PNG with alpha, PSD or ORA
   with the mask intact.
7. Agents: `key_screen` (I7), in the assistant's RUNS set (it asks first); `preview: true` puts the matte into the
   selection instead of landing a layer.

**The first time:** the dialog says the CorridorKey 2.0 set is not downloaded (about 2.4 GB, fp16, from the host named
in Settings › Helpers), names the four components with their licences and the one clause users must know
(organisations above US $20M revenue need a CorridorKey seat per user), and offers the download, which runs in
Settings › Helpers with one bar for the whole set. Nothing of it is in Scumble's installer, MSIX or zip.

**A 15k document:** the engine never sees 150 MP. It keys the selection's box with context (or the whole picture when
nothing is selected) at the working size (1,024 px on the long side by default; larger buckets only where the spike and
I1 proved them), and the matte comes back to the box's size in bands and is refined against the full-resolution
picture (I6), so a 4k subject on a 15k photo costs a 4k layer, not a 600 MB one. No document-sized canvas is made
anywhere (the 268 MP limit, `renderer/editor/inpaint_pixels.js:71-80`). If a ComfyUI with a CK2 node pack is connected,
*Full resolution on your ComfyUI* is the phase 2 option for the final key (Route B, §4.11), built only if Stop B shows
the refined in-app matte too soft on the user's pictures.

## 2. The facts that decide the design

### 2.1 CorridorKey 2.0 itself (corrections to CLAUDE.md item 49)

- **v2 lives in its own repo**, nikopueringer/CorridorKey2.0 (default branch `master`, no tags, no releases; read at
  `485f5e9`, 2026-10-15). The GitHub repo was created 2026-07-15, but its first commit "CorridorKey 2.0" and the
  Hugging Face weights are dated **2026-10-13**: the public release was October 2026, not July. The v1 repo
  nikopueringer/CorridorKey holds only GreenFormer. (GitHub and HF API; read)
- **Five networks, not one.** Three frozen feature models fed from the display RGB alone and read at /64: C-RADIOv4-
  SO400M (NVIDIA, 1,724,986,512 B), the MoGe-2 ViT-B **encoder only** (Microsoft, 419,110,160 B) and **"RVM" = Google
  DeepMind's Recurrent Video MAE** (representations4d, 270,086,372 B), **not Robust Video Matting**; then Corridor's own
  model `corridorkey_v2.safetensors` (2,661,698,720 B, 738 tensors, all F32, 665M parameters: stage 1 463.6M, stage 2
  201.8M). About **5.08 GB** in all; that *is* the README's "about 5 GB", not 5 GB on top. Nothing is gated. (HF tree
  API, the safetensors header by range request; `corridorkey/rvm.py:1-56`, `foundations.py:267-278`; read)
- **v1 is 398.8 MB, not about 300**, squashes the whole frame to 2048 × 2048, needs a hint, and is fine-tuned from
  Meta's Hiera zoo weights, which are CC BY-NC 4.0 and which Corridor cannot waive. Out (the user chose v2 anyway).
- **A still runs through v2.** A one-frame folder is a one-frame clip: `window_starts(1, ...)` returns `[0]`, the Hann
  taper of one window is all ones, RVM starts from a zero state; the 1/1 window "keys each frame on its own" (README
  L246); pack A lets a one-frame clip take 1/1 (`ck_comfy/pipeline.py:254-289`, the floor is 2 only above one frame).
  (read; the folder path itself inferred)
- **Native resolution.** The picture is reflect-101 padded at the centre to a multiple of 128 (`runtime.py:105`;
  `video_io.py:103-112`), no tiling, no maximum in the code; `--model_scale` other than 1 raises. The VRAM table is
  measured only to 8.36 MP and extrapolated linearly beyond (`runtime.py:132-170`). C-RADIO is tested at 256-2048 px
  and gets H/4, so sides above about 8192 px leave its tested range (inferred).
- **The hint enters at the first layer** (a 4-channel patchify of RGB + hint, `stage1.py:340-346`, and AdaLN on
  `hint_quality` in the first two blocks, `:365-376`): any hint change re-runs **all of stage 1 and stage 2**; only
  the three feature models (about 8 % of a still's time on the MLX port's 1536 × 1024 measurement) can be cached.
  `hint_quality`: 0.95 clean matte, 0.75 rough automatic mask, 0.5 or less a loose scribble; **no hint = zeros at
  quality −1, the model decides the subject** (`runtime.py:485-502`, `stage1.py:741`, README L188-215). There is no
  separate garbage or core matte. **No public CK2 code has a live hint**: `run_interactive.py` is a text wizard and the
  GUI PRs shell out to `infer.py`; what Neex's "real time" refers to is unverified (asked, §3.4). Stage 1 also gives
  `alpha_aux` at /2 (`pipeline.md` §4): a cheaper preview while a stroke is going, if the spike finds stage 2 the cost.
- **Colour.** Input display sRGB in [0,1] (PNG / JPG read by OpenCV and divided by 255, so 8-bit; inferred) is converted to
  linear and a signed asinh code for stage 1 / 2; the feature models get SDR RGB. Output: alpha in [0,1] and a
  **straight (unpremultiplied) scene-linear foreground, unclamped**. Upstream's own despill is the green limit
  `g − (r + b) / 2` with the spill split over the other two channels, whatever the screen (`runtime.py:604-614`).
  (`color_utils.py:4-5, 98-128`; `model.py:13-22`; read)
- **Runtime.** Weights fp32, every pass under `torch.autocast("cuda", bfloat16)`, plain SDPA, no ONNX / TensorRT /
  compile in the official code; `infer.py` refuses without CUDA; AMD only through unmerged ROCm PRs, Apple through an
  MLX port; **no CPU and no DirectML path**. RTX 30 or newer, 4 GB VRAM up to 1440p, 6 GB at 4K (README L21-23).
- **Cost of a hint change** (inferred FLOP count, `pipeline.md` §4): about 6 TFLOP at 1080p, 34 at 4K, 190 at 24 MP,
  550 at 8192 × 5464, 5,500 at 15k × 10k; the full-spatial attention over all /16 tokens dominates (two blocks in
  stage 2 at d = 1280, one class in stage 1). On a 4090-class card about 0.1 s at 1080p, 0.5 s at 4K, a few seconds
  at 24 MP, a minute or two at 150 MP. "Real time" holds at video sizes, not at 15k: hence a working size (§4.7).
- **Licence:** §3.

### 2.2 The ComfyUI packs (read 2026-10-24; clones in the scratchpad `ck_comfy/`)

Exactly **two packs run CK2**, both a day or two old, 0 stars, 0 issues, both vendoring upstream `485f5e9` unchanged
under the Corridor Key Licence 2.0. Every other CorridorKey pack (cnoellert, SeanBRVFX, pixelworldai, KoLt-Real whose
"V2" is only its name, Mister-Link, YAK, TrentNodes) runs **v1**; item 49 named two of those. None is Active on the
Comfy Registry; ComfyUI-Manager's list holds only two v1 packs. **Comfy Cloud has no CorridorKey node** (0 of 3,835).

| | **A: marawan206/ComfyUI-CorridorKey2.0** (`eeee7fa`, 2026-10-22) | **B: hashu786/ComfyUI-CorridorKey2** (`141c31b`, 2026-10-23) |
|---|---|---|
| Nodes | `CorridorKey2ModelLoader` (`weights` combo, `auto_download` default **true**, `keep_on_gpu` default false, `vram_reserve_gb`) → `CorridorKey2Basic` (`model`, `images`, optional `alpha_hint` MASK white = subject, `hint_quality` a combo of three presets, `invert_hint`, `despill` 0.5, `screen` green / blue) → `foreground` (straight sRGB, despilled), `alpha` (MASK), `rgba` (4-channel IMAGE); `CorridorKey2Advanced` adds `process_scale` 0.25-1, `low_vram`, `input_colorspace` / `output_colorspace`, an `info` string (`nodes/model_nodes.py:32-62`, `nodes/keyer_basic.py:20-72`, `nodes/keyer_advanced.py:93-106`) | one node `CorridorKey2` (`image`, `gamma_space`, `hint_quality` FLOAT, `carry_hint`, `despill_strength` 0.5, `window` auto … 1/1, `low_vram`, `unload_other_models` default **true**; optional `mask`) → `fg`, `matte`, `processed`, `QC`, `cutout` (RGBA, slot 4); only connected outputs are computed (`nodes.py:55-158`) |
| Despill | `color.despill(..., screen)` swaps the key channel for blue (`ck_comfy/color.py:18, 36-49`): **blue screens are despilled** | green-only (`nodes.py:76-80`) |
| Still | a one-frame clip may run 1/1 (`pipeline.py:275`) | upstream's auto window goes down to 1/1 (inferred) |
| Output bytes | `fg_space="srgb"`: the linear fg clamped at 0, sRGB-encoded, clamped to [0,1] (`keyer_basic.py:62`, `pipeline.py:598`); `rgba[..., :3] = fg`, `rgba[..., 3] = alpha` | `cutout` RGBA in the input's colour space |
| Missing models | `auto_download: false` raises `FileNotFoundError` naming every missing file in a second (`model_nodes.py:58-62`); `scripts/download_models.py` for an offline copy | downloads regardless; off only by the server env `CORRIDORKEY2_NO_DOWNLOAD=1` |
| Memory | the model moves back to system RAM after a run unless `keep_on_gpu`, released when ComfyUI frees its cache (`model_nodes.py:44-47`); the auto window asks ComfyUI to unload other models; load about 10 s | offloaded to the CPU after a run; other models unloaded first by default |
| Needs | ComfyUI ≥ 0.25 (the V3 io API; the user runs 0.42.4) | no `pyproject` |

Pack A's measured speed (an RTX 4090, the model loaded, clips): 0.28 s per frame at 1080p, 1.17 s at 4K in low-VRAM
mode, 0.29 s at 4K with `process_scale` 0.5 (README L219-236). A still pays the per-frame figure plus the PNG round
trip, the queue and the model's move to the GPU. **Neither pack caches the feature models across runs** (inferred from a
grep, `comfyui.md`), and ComfyUI's cache hits only on identical inputs: every hint change re-runs everything.

Upstream's `estimate_peak_vram_gb` counts a still as **8 frames in normal mode** (`runtime.py:160-170`, `frames =
max(frames, chunks[0])`), 13.9 GB at 8.36 MP extrapolated; pack A's `select_profile` then falls to low-VRAM mode, which
is slower. So a cap of 16 MP sits inside normal mode on a 32 GB card only if the budget allows it; **I0a records the
mode the Advanced node's `info` string reports** (the fact Route B's cap needs).

**In this plan pack A has two jobs:** the parity reference for the spike (the only runtime Corridor validates, run on
the user's card at the spike's bucket sizes and at native, I0a) and the engine of Route B (§4.11).

### 2.3 The in-app ONNX route (the spine; what the spike must prove)

- onnxruntime-node 1.29.0 on Windows ships CPU, DirectML and an **experimental** WebGPU provider; **no CUDA, no
  TensorRT on Windows** (`node_modules/onnxruntime-node/README.md`; `electron/main/onnx/runtime.js:19-26` never tries
  `webgpu`). Session creation and `run` are synchronous native calls: every helper but LaMa blocks main's thread.
- **DirectML** is in maintenance mode, its core kernels stop at opset 21, LaMa fails on it (`docs/HELPERS.md:285-291`),
  and one 1024² BiRefNet-lite run took main's private bytes from 1.3 to **24.7 GB** (B5, `docs/BUGS.md:110-119`). An
  open issue shows its attention kernels wrong on RDNA2. DirectML registers `com.microsoft` `MultiHeadAttention`
  (`onnx.md` §5); whether that kernel avoids materialising the scores is unknown.
- **WebGPU in onnxruntime-node** runs `MultiHeadAttention` through a flash-attention path when `head_size % 4 == 0`
  (CK2's head sizes 64, 96, 80, 72, 64, 48 all qualify, inferred from the configs; `onnx.md` §5); experimental, untried
  in Scumble; wrong results reported in Electron on Intel integrated GPUs **for ORT-web in a renderer, not for the Node
  provider** (`onnx.md` §5).
- **No official ONNX.** Nucito/corridorkey-web (fp16, opset 17, default domain only, attention decomposed, 18 static
  buckets up to **1024²**, 2.43 GB, one day old, ships C-RADIO without NVIDIA's `Notice` file, licence "other"; its
  `manifest.json` names each graph's inputs: stage 1 takes rgb / hint / hint_quality / moge / cradio / rvm, so the set
  is cut exactly at the hint boundary); MarcelineVPQ/corridorkey-desktop (dynamic shapes, opset 23 +
  `com.microsoft::MultiHeadAttention`, needs ORT ≥ 1.31, files unpublished, five patches to export, checked on CPU and
  CUDA only).
- **Quadratic attention:** without a fused kernel the stage-2 score tensor is about 0.54 GB at 1024² and **8.6 GB at
  2048²** (inferred). Native 4K or 15k in-app is out; a working size is a product decision (§4.7).
- Verdict of the reader: plausible at about 1 MP in a utility process, risky beyond, **measure first**. The user chose
  this route first (2026-10-24); the facts above are why the spike (I0b, Stop A) comes before any app code.

### 2.4 Scumble's side (read at `ec1142b`)

- **No existing route carries colour and alpha into one layer.** An edit recipe loses the alpha (the node's stitch keeps
  RGB and writes the layer's alpha from the feathered selection, ComfyUI-InpaintCanvas `nodes.py:873-874, 921`); the
  whole-picture route refuses any graph that reads the mask (`renderer/editor/comfyprompt.js:57-71`) and replaces the
  base; the cutout route lands only a mask over the layer's old pixels (`renderer/editor/inpaint_canvas.js:16386-16419`),
  so the green edges stay, and it passes no hint. For Route B a **helper prompt of Scumble's own** in the shape of
  `realism.passPrompt` (`renderer/editor/realism.js:469-482`: LoadRef → pack nodes → `PreviewImage`), run through
  `host.comfyPictureRun` (`renderer/editor/host.js:3025-3137`: queue, wait, cancel, timeout, `/history`, the bar) and
  landed with `addLayer` (`inpaint_canvas.js:18657-18689`) does it with no node change.
- **The in-app helper chain** the engine joins: editor → `host.helperCall(name, args)` (`host.js:4814`) → preload
  `helpers.*` (`electron/preload.js:182-199`) → `ipcMain.handle("helpers:*")` (`electron/main/main.js:1211-1226`) →
  `electron/main/onnx/index.js` (`DEFAULTS` `:20`, `MISSING` `:158`, `clearInstances` `:98`, `free` `:153`; LaMa's
  instance is killed on a folder change and removal, `:144-145`, and at `will-quit`, `main.js:1387`). `editor.helperUsed
  = true` makes `freeHelpers` (`host.js:5357-5362`) free the sessions before a local ComfyUI run; SAM2 keys its cached
  embedding by `compositeVersion` plus an input hash (`host.js:5090`, `electron/main/onnx/sam2.js:54-73`). **LaMa's
  utility process** (`electron/main/onnx/lama.js:76-88` `spawn`, `lama_process.js`, 30 lines: `process.parentPort`
  messages `{ id, type, ... }` → `{ id, result | error }`) is the only helper off main's thread; a worker thread killed
  inside a native call crashed (`lama.js:16-24`).
- **`InpaintCanvasLoadRef` loads RGB only** (`nodes.py:949-975`); a hint goes as a grey PNG through core `ImageToMask`
  channel red (ComfyUI v0.42.4 `comfy_extras/nodes_mask.py:149`): white = 1 = subject. `JoinImageWithAlpha` inverts
  its mask and is not used. ComfyUI's `PreviewImage` writes a 4-channel IMAGE as an **8-bit straight RGBA PNG**
  (`nodes.py:1708, 1730`). (Route B.)
- **Layers are 8-bit straight RGBA8 tiles**; bytes entering without a canvas pass the measured premultiply round trip
  (`inpaint_tiles.js:3-5, 27-30, 537-553`), so a straight colour at alpha *a* survives with about *a*+1 levels
  (inferred). The compositor blends gamma-encoded bytes with premultiplied 8-bit integer maths and no linear conversion
  (`crates/px/src/composite.rs:1-21`; inferred: no sRGB / linear conversion found there or in `inpaint_compositor.js`).
  There is no 16-bit layer path. **`Layer.fromImage` draws through a 2D canvas and
  premultiplies** (`inpaint_tiles.js:797-804`): straight bytes go in through `writeRect`, never through a canvas.
- **Banded writers exist:** `readPng(blob, { onRows, rowsPerBand })` (`inpaint_png.js:201`; the pool's `png_read` op,
  `inpaint_worker.js:635-647`), `writeRect` / `putCanvasRows` (`inpaint_tiles.js:1400-1420`), `Layer.empty` (`:785`),
  `MaskPixels.combine(src, mode)` in 256-row bands (`inpaint_pixels.js:604-637`; tiles `inpaint_tiles.js:2556-2582`),
  `bytesSource` (`inpaint_raster.js:396-415`). **Trap:** `combine` with `"replace"` or `"intersect"` clears everything
  outside `src.box`, so bands written one after another wipe each other; `selectLogits` maps a replace to `"add"` per
  band for that reason (`inpaint_canvas.js:7934`).
- **A landed mask persists only when flagged:** `addLayer` sets `maskDirty` only to false (`:18670`); `syncLayers`
  uploads a mask only when `maskDirty && maskPx` (`:22785`); `getValue` stores `mask: l.maskRef || null` (`:24475`);
  the restore rebuilds `px` from `l.ref` (`:24626`, `:24667`). The import callers pass `dirty: true, maskDirty:
  !!L.maskPx` (`:16881`, `:18604`). A landing without both flags loses the matte at the next start.
- **The Fill layer exists and is procedural on tiles:** a filter layer `fill` with `params.color` (`addFilterLayer(id)`
  `inpaint_canvas.js:15271`, rows from `fillPixels` per band, `fillLayerCanvas` / `fillLayerRows` `:15363-15382`); on
  tiles `Layer.empty` is a tile store (`inpaint_tiles.js:785`), so the grey layer under a key of the base costs no pixel
  memory at 15k (a Fill layer with a depth limit is the one slow case, `limitAlphaRows`, K25); **on the canvas backend
  its `px` is a real W × H canvas** (`inpaint_pixels.js:161`), so the "no pixel memory" claim holds on tiles only.
  `addFilterLayer` seeds the fill's colour from the paint colour (`:15278`, `:15346`), names the layer `Fill N`, calls
  `addLayer` (a `notifyChanged`, the new layer activated) and writes its own status line (`:15283`); a `params.color`
  set afterwards needs `markFilterChanged(layer)` (`:15388`) or the cached rows stay in the paint colour.
- **What the app side hears of a stroke without a shipped file changing (question 8):** every selection change ends in
  `markSelectionChanged` (`inpaint_canvas.js:14942-14960`: `selectionSeq++`, then `notifyChanged()`), the selection
  brush's pointer-up included (`:6832-6836`, "the dabs kept the levels up to date"); a mask stroke ends in
  `markMaskChanged` (`:16292-16313`), which also ends in `notifyChanged()`; `notifyChanged` calls `host.changed(this)`
  (`:24392-24395`), and `host.changed` emits `"changed"` (`host.js:4347-4355`), which host.js, shell.js and the plugins
  already listen to. So a stroke's **end** reaches app-only code with `editor.selectionSeq` (`:2236`) to tell a selection
  change from any other. **During** a stroke app-only code hears every dab too: `host.pluginPointer(this, "down" |
  "move", e, ix, iy)` is called on every press and every pointer move **before any brush branch** (`:6136`, `:6529`);
  only `"up"` is gated on `p.kind === "plugin"` (`:6755`); host.js implements it app-only by delegating to the plugin
  registry (`host.js:1210-1212`) and may listen first and return false, so the brush goes on. The selection brush and
  the quick mask (Q with the paint / erase tool) write `this.sel` directly per dab (`kind: "selpaint"`, `:6169`,
  `:6327`; `selectionDab` `:6961-6986` ends in `touchSourceRect`, `:6985`), so the selection's levels are current after
  each dab and `selectionCanvasSettled` reads the live stroke. **A mask stroke is different:** P / E on a layer mask
  paints into a `StrokeBuffer` (`kind: "maskpaint"`, `:6340`); the mask's pixels are written at pointer-up by
  `commitStroke` (`:6877-6881`, `:11829`), mid-stroke `layer.maskPx` is the old mask, and `objectInput` refuses the tiled
  read while `liveStrokeOn(layer)` (`:12000`, `host.js:4908`); only the pass path composes the buffer (`layerWithStroke`,
  the note at `:12005-12010`). **Drawing on the canvas without a shipped file changing:**
  `drawOverlays` calls `host.pluginOverlay(this, ctx)` on every frame with the view transform applied (image pixels;
  under a straighten preview it turns with the picture), before the boxes and the light handles (`:4757-4766`);
  host.js implements it by delegating to the plugins (`host.js:1219-1222`) and may draw first; `editor.drawSoon()`
  (`:22800`) requests a frame. Overlays are screen-only (`:21366`, `:23591`): no export or screenshot carries them.
- **`withSpecDefaults` is private to `inpaint_canvas.js:1046-1064`** and calls `host.nodeTypes()`; `comfyprompt.js` is
  app-only and pure ("not in tools/build_node.py FILES", `comfyprompt.js:10-11`). `tools/build_node.py` FILES (`:36-49`)
  lists the editor modules the node ships (`inpaint_worker.js`, `inpaint_depth.js`, `inpaint_pool.js` among them);
  `realism.js`, `comfyprompt.js`, `host.js`, `stitch.js` are app-only; every `host.<member>` a shipped file uses must
  exist in the node's own `js/host.js` too (`check_host`, `:163-171`; the flags `removeSupported` / `depthSupported`,
  node `js/host.js:165, 178`). A new pool op in `inpaint_worker.js` calls no host member, so it needs no flag, only the
  node build.
- **Reads at model size without a full flatten:** `pictureInputBox(editor, box, w, h)` (`host.js:5235-5261`, tiles
  through `sampleRegionSettled`, canvases through `flattenToCanvas`, which documents under 268 MP allow),
  `cutoutInput` (`:4945-4967`, a layer's own pixels from its levels), `objectInput` (`:4899-4940`, a layer with its mask
  under a transform), `selectionCanvasSettled(box, scale, w, h)` (`inpaint_canvas.js:9209-9225`, the mask's mip levels;
  null on canvases, where the depth edit's `sel.drawTo` crop is the fallback, `:13666-13680`). **`maskToCanvas`
  (`:22689-22701`) reads the whole selection at document size and is not used.** **Reading under a layer:**
  `sampleRegionSettled` passes its `opts` through (`:9189-9200`), and `sampleRegion` / `readBox` / `boxReach` /
  `passStores` / `drawLayersInto` / `bandPlan` / `bandSource` all take **`upTo`** (the composite of the layers below that
  index only, `:21708-21709`; `boxReach` `:8402`, `passStores` `:9109`, `readBox` `:9227`, `:22552`, `:22650`), as a
  filter's own input (`:22475`) and the colour match (`:8834-8845`) use it. Nothing is ever hidden by hand for a read
  (CLAUDE.md's trap: a `visible` set by hand leaves the composite version where it was).
- **The guided filter exists for depth:** `guidedFilter(I, p, w, h, r, eps, box)` (`inpaint_depth.js:213`) takes **one
  grey channel** as the guide (`I` a single `Float32Array`) and runs on **one whole array** (`box(I, w, h, [r])`), never
  in bands; `guidedFar` (`:269`, builds `I` from `grey`, normalises by `disparityRange`, inverts, returns u16: not
  reusable as it is); the pool op `depth_guide` (`inpaint_worker.js:1010-1014`, dispatched `:1394`) is called on the
  whole map (the guide 44.7 MB at 4096 × 2731, `HELPERS.md:296-304`; 3.4 s at 4,096 px) and shares `boxBlurs` from
  `px/kernels.js:370`. **The precedent that bands correctly** is `range_select` (`:7940-7975`): the small float logits
  go to the worker, which upsamples them per 256-row band inside and answers tiles. The matte's refine (I6) takes that
  shape: the small alpha in, upsampled and filtered per band with a halo, u8 rows out (§4.7 point 3). **An app-only
  module worker already exists:** `stitch.js:822` starts `stitch_worker.js` (neither in FILES).
- **Masks are white where they let through:** `combine(src, mode, color = [255, 0, 0])` defaults to the selection's red
  (`inpaint_tiles.js:2560`, `inpaint_pixels.js:604`); layer masks are written with `MASK_RGB = [255, 255, 255]`
  (`inpaint_canvas.js:345`, used at `:5630`, `:5656`, `:16454`, `:16482`, `:17446`). The views draw a mask by alpha, so a
  red one looks right and differs in bytes from every other mask's.
- **A layer field is stored only when named:** `getValue` writes an explicit list of layer fields (`:24473-24485`) and
  the restore names each (`relightOf: l.relightOf || null`, `:24669`, the precedent for a per-feature field); `match` is
  dropped at strength 0 (`:24477`). A new record on a layer is gone at the next autosave or restart unless both places
  change, and that is a `.scumble` field (Full tier). `snapshotLayer` (`:14092`) does copy it for undo.
- **Readiness and refusals to reuse:** `realism.serverSupport({ state, os, gpus, objectInfo })` and `gpuGeneration`
  (`realism.js:74-128`), `realismWholeCheck` (`host.js:3386-3401`), `resizingRun` (`inpaint_canvas.js:12489`),
  `RUN_GOING_TEXT` (`:92`), `slowHelperHint` (`host.js:5344`). A run holds the document like a provider run
  (`editor.providerPending`, `_providerRuns`, the title row's Cancel, `host.js:3435-3442`); closing the tab ends it.
- **Undo:** `pushUndo({ kind: "layers", label })` then `addLayer` is one step (`host.js:3551-3557`); `snapshotLayer` is
  `{ ...l }` (`inpaint_canvas.js:14092`), so a `visible` change in the same step is restored with it; the mask-replace
  step kind is `layerfull` (`:3024`, `:5154`). **The base cannot be hidden** (no such field); only layers have `visible`.
- **Agents:** `cutout_layer` (`renderer/commands.js:1999-2016`) and `realism_pass` (`:1479-1502`) are the command shapes;
  the policy's `RUNS` set (`electron/main/assistant/policy.js:21`); `select_mask` thresholds to 0 / 1 (`commands.js:1031-
  1040`), so an agent's hint through the selection is binary. The tool count 116 is in `README.md:83, 303` and
  `docs/MCP.md:306`; `tools/mcpb_build.js:39` reads `docs/COMMANDS.md`.
- **Limits:** canvases 65,535 px a side and 268 MP; an IPC message of 600-800 MB ended the renderer, 500 MB passed (G2);
  the engine's answers at a 2048² bucket are about 28 MB (a float alpha and an RGB foreground), far under it.
- **The downloader** (`electron/main/onnx/models.js:292-331`) checks size only (`:326-327`), sends the HF token as
  Bearer to **every** URL (`:298-299`; no leak is live, every registry URL is huggingface.co today, but an entry on
  another host would send the token there; `docs/BUGS.md` has no line yet: it goes in with this plan's commit, I2 fixes
  it), shows one file's progress (`renderer/shell.js:2088-2090, 2136-2143`), and `findFile` looks each name up across
  flat `SUBDIRS` (`:78-95`); on a linked ComfyUI `models/` folder downloads land in its `onnx/` (`downloadDir`, `:84-87`),
  while pack A keeps its fp32 set at `<models>/corridorkey2/` (§3.2), which Scumble must not search; the registry's
  `files[].name` renames on download (`:269-273`), and ORT resolves external data by the name inside the graph beside
  the `.onnx` (inferred from the path-based load, `runtime.js:50-71`). I2 fixes all of it (§4.4) before the first
  multi-GB set is offered.
- **The ONNX runtime's pin:** `package.json:38` has `"onnxruntime-node": "^1.29.0"` (1.29.0 installed); a fresh `npm
  install` may pull 1.30 silently, and every helper (SAM2, BiRefNet / RMBG, LaMa's CPU path, Depth Anything) and the
  packaged exe run on whatever is installed. The Comfy SDK precedent (S0) pinned exactly for that reason. A
  `utilityProcess.fork(script)` resolves `require("onnxruntime-node")` from the script's own location (`lama.js:80`,
  `lama_process.js:10`), so a second build has to be named by path.
- **Per-process VRAM is not readable through nvidia-smi here:** under WDDM `--query-compute-apps=pid,used_memory` answers
  `[N/A]` per process and lists CUDA contexts only, so a DirectML or WebGPU utility process never appears; only the
  card's total `memory.used` is readable, and it is noisy beside ComfyUI's resident models (8,115 MiB of 32,607 used with
  the queue idle, measured 2026-10-24). Windows' GPU performance counters give it per process: `Get-Counter '\GPU
  Process Memory(pid_<pid>*)\Dedicated Usage'` and `'\GPU Adapter Memory(*)\Dedicated Usage'` for the card.

## 3. Licences and notices

### 3.1 The Corridor Key Licence 2.0 (read: `CorridorKey2.0@485f5e9` LICENSE, byte-identical on HF)

CC BY-NC-SA 4.0 plus additional terms that take precedence; "this tool" means the software **and the weights**. It
allows any lawful use, including commercial image work (§1(a)); the outputs are the user's, also commercially (§1(b));
donations if paying nothing stays possible (§2(c)). It forbids repackaging, redistributing or selling the tool as a
standalone or competing product and charging for access to code or weights (§2(a)); **paid API or inference services,
directly or indirectly** (§2(b)); it requires released derivatives to be free to the public (§2(c)); a **commercial
software package** needs a written agreement (§2(d)); organisations with more than **US $20M** gross revenue in the last
fiscal year, counted across the group, need one plugin seat per individual user, else §1 does not apply (§3; $27
personal, $42.50 per studio seat at corridorkey.com, 2026-10-24); attribution must include the name **"CorridorKey"**,
and a fork or derivative keeps it in a reasonably prominent position (§4); public derivatives go under the same licence
(§5); third-party parts keep their own licences (§6). CC licenses no trademarks (no logos).

**Consequences for Scumble:** nothing of it in the installer, MSIX, zip or asar (the MIT / Apache / BSD / OFL rule; the
set is a user download like RMBG-2.0, `models.js:46-56`); **no route through fal, Replicate, Comfy Cloud or any paid
host, ever** (§2(b); Comfy Cloud has no node anyway); the seat clause binds Scumble's *users* and Scumble cannot waive
it, so the pre-download dialog and the manual state it; a sale of Scumble means asking Corridor first. **Route B is
GPL-clean:** a ComfyUI graph is data, the pack's code and the weights live on the user's ComfyUI machine, Scumble's own
code (the graph builder, the landing) is Scumble's. **The in-app engine (Route A) is kept GPL-clean the same way:** the
weights are a user download under Corridor's licence (never in the repo or the bundle); the pre- and post-processing
(`electron/main/onnx/keycolor.js`) is written from the README's documented input and output conventions as Scumble's own
code, not a port of upstream's modules: **the source of record is `README.md` L509-541** (the colour pipeline: display
sRGB → linear, the signed asinh code with knee 0.008 and reference 16, the straight scene-linear foreground), and the
despill is the **generic green-limit despill** (`g − (r + b) / 2`, the excess redistributed over the other two channels, a
textbook formula implemented from first principles, not from `runtime.py`), so the "not a port" claim is checkable at
review (`pipeline.md` §2 cites the source files only to confirm the README). **Nothing ported from `corridorkey/*.py`
enters the repo.** The export scripts that load Corridor's code to write the ONNX set stay **out of the repo** (the
scratch folder, `dist/ck_export/` untracked); they are committed here only on Corridor's written yes to question 1,
else they stay local or go to a separate repository under Corridor's licence. **A separately licensed folder in the app
is not a path:** CLAUDE.md's licence decision (GPL-3.0, no dual licensing, only MIT / Apache / BSD / OFL dependencies in
the app; the SignPath Foundation signing needs an open-source project) is not reopened by this plan, and the FSF lists CC
NonCommercial licences as non-free (`licences.md` §1), so CK-licensed code inside the bundle would be non-free code in
a GPL app. A written "no" to question 1 leaves Route A as built (Scumble's own glue, the weights the user's download)
and is reported to the user, who alone may reopen the licence decision.

### 3.2 The components (the set the engine runs, and what pack A downloads onto the ComfyUI machine)

| Component | Publisher, pinned source | Licence | Size (fp32 source) |
|---|---|---|---|
| CorridorKey 2.0 (`corridorkey_v2.safetensors`, `foundation_stats.safetensors`) | `nikopueringer/CorridorKey2.0` @ `cf44a8d` | Corridor Key Licence 2.0 | 2.66 GB |
| C-RADIOv4-SO400M (`model.safetensors`) | `nvidia/C-RADIOv4-SO400M` @ `c0457f5` | NVIDIA Open Model License (commercial use; a redistributor ships the agreement plus a `Notice` file; NVIDIA named for origin only) | 1.72 GB |
| MoGe-2 ViT-B normal (`model.pt`, the encoder is used) | `Ruicheng/moge-2-vitb-normal` @ `ca5f0e0` | MIT (DINOv2 code inside Apache-2.0) | 419 MB |
| RVM small, Recurrent Video MAE (`pretrain_rvm_small16_256_204031069.npz`) | `storage.googleapis.com/representations4d/...` (md5 pinned) | weights CC BY 4.0, code Apache-2.0 | 270 MB |

(`scripts/download_weights.py:77-88`, `THIRD_PARTY_NOTICES.md`; the HF API and a HEAD request; read.) Pack A's loader
fetches them into `models/corridorkey2/` (`corridorkey_v2.safetensors` + `foundations/{cradio,moge,rvm}`), resumable.
**The in-app set is a conversion of the same four** (fp16 ONNX, about 2.4-3.3 GB: C-RADIO may have to stay fp32,
`onnx.md` §4): the same four licences travel with it, plus "converted to ONNX / fp16 by Scumble" on each part. I1 reads
the fp32 sources from the ComfyUI machine's `models/corridorkey2/` once I0a has them there: no second 5.1 GB download.

### 3.3 Where the notices show

- **The pre-download dialog of Scumble's own** (Route A; the first-run block of the Key dialog opens it, and Settings ›
  Helpers' Download does), one paragraph: *CorridorKey 2.0 by Corridor Digital, Corridor Key Licence 2.0 (CC BY-NC-SA
  4.0 with their terms), used with their permission in this free app; this set is a conversion to ONNX of their
  weights and of C-RADIOv4 (NVIDIA Open Model License), MoGe-2 (MIT) and RVM (Google DeepMind, CC BY 4.0), about 2.4 GB,
  downloaded from <host>. Your keyed pictures are yours, also commercially. Organisations with more than US $20M yearly
  revenue need one CorridorKey seat per user (corridorkey.com).* With links to the licence, corridorkey.com and the
  set's notices file. The Settings › Helpers row shows the licence as the RMBG rows do (`shell.js:2079`).
- **The first-run block for Route B** (shown while the models are missing on the ComfyUI machine, §4.11): the same
  paragraph with "which the node pack downloads from their publishers onto your ComfyUI" in place of the host line.
- **About** (`renderer/shell.js:2460`): "Green and blue screen keying by CorridorKey 2.0 from Corridor Digital (Corridor
  Key Licence, a CC BY-NC-SA 4.0 variant), used with permission in this free app; it builds on C-RADIOv4 (NVIDIA),
  MoGe-2 (Microsoft) and RVM (Google DeepMind), downloaded from their publishers or as Scumble's ONNX conversion." No
  logos.
- **`THIRD_PARTY_NOTICES.md`** in the repo root and inside the hosted set, once Scumble hosts a converted set (I2 writes
  it, the release publishes it): Corridor's LICENSE, NVIDIA's agreement and `Notice` ("Licensed by NVIDIA Corporation
  under the NVIDIA Open Model License"), Microsoft's MIT notice, the Apache-2.0 notice, the CC BY line, each part marked
  "converted to ONNX / fp16 by Scumble from <source @ revision>".
- **The manual chapter** (§4.12): the hardware need per provider, what the download is and under which licences, the
  seat clause, the working size and the refine, the gamma-compositing and 8-bit notes; Route B's pack install steps
  dated to its commit when Route B is built. **`docs/HELPERS.md`:** a row per part of the set with the pinned revision,
  the sha256 and the licence (as the other models have), and the section "Models on your ComfyUI that Scumble drives"
  only with Route B. **`docs/RECIPES.md`:** only with Route B (the pack, its commit, the graph, as the Realism Pass's
  pack is named, `docs/RECIPES.md:259`). **`docs/CODE_SIGNING_POLICY.md:101`** (the Store's privacy URL) names Hugging
  Face as the helper download host already: a set hosted there is no new host; Route B's RVM comes from Google Cloud
  Storage onto the ComfyUI machine, which the manual says. **The Store listing's description** names keying when
  0.1.52's notes go up; the 11.16 generative-AI disclosure is a general Store question (§6), not CK's.
- **Naming in the UI** (CLAUDE.md's rule): the feature is "Key green / blue screen", the layer "Key"; "CorridorKey 2.0"
  appears where the text is about running it (the dialog's title line and licence paragraph, the Helpers row, the
  status sentence, About, the manual), which the rule allows for a model and the licence's §4 wants.

### 3.4 Questions for Corridor (in writing; the thank-you reply drafted in chat on 2026-10-24 carries 1-3 and 5 in short form, whether it was sent is confirmed in §6; 4, 6, 7 after Stop A)

1. Scumble is GPL-3.0. May our own glue (the ONNX export scripts, the pre- and post-processing written from your
   README's conventions) be released under GPL-3.0 while the CorridorKey weights stay under your licence?
2. **May Scumble host a converted copy of the weights (ONNX, fp16) under your licence and name with every third-party
   notice (NVIDIA's `Notice`, DeepMind's CC BY attribution, Microsoft's MIT), or would you rather publish an official
   export we can point at?** The release of the in-app route waits for this answer (§4.3).
3. How do you want to be credited in the app (wording, a link to corridorkey.com; no logo, since CC licenses no
   trademarks)?
4. We will tell users that organisations above US $20M revenue need one seat per user. Is this wording right:
   "Organisations with more than US $20M yearly revenue need one CorridorKey seat per user (corridorkey.com)"?
5. "The alpha hint works in real time": does that refer to your plugin keeping the feature models' output between hint
   edits (a hint-only re-run of stage 1 + 2), and is any of that path public? In Scumble we cache the three feature
   models' output per picture and re-run stage 1 + 2 per hint; our measured figure is <Stop A's number> at 1,024 px.
6. Stills above 4K: is CK2.0 validated there, and above about 8192 px a side where C-RADIO's input leaves its tested
   256-2048 range? We key at a working size and bring the matte up against the picture with a guided refine, with the
   user's own ComfyUI as the full-resolution option. Would you cap, downscale and refine, or tile?
7. Blue screens: is the foreground already unmixed for blue spill, and does the green-limit despill need its blue
   counterpart on stills (we swap the channel, as one ComfyUI pack does)?

## 4. The design

### 4.1 Routes

**Route A, the spine: CK2 inside Scumble.** The five ONNX graphs on onnxruntime-node in an Electron **utility process**
(LaMa's shape, `lama.js:76-88`), the GPU through the provider the spike proves (DirectML or WebGPU; `onnx.md` §5), the
three feature models' output cached per picture and stage 1 + 2 re-run per hint, so the alpha hint Corridor describes as
"real time" is live while the Key dialog is open (§4.6). Scumble's rules hold: no Python or Torch bundled; the set a
user download under its licences (§3); Scumble keeps working without the set (the entry stays, the dialog says what is
missing) and without any ComfyUI. Native 4K and 15k are out of reach in-app (§2.3), so the engine keys at a **working
size** and the final matte is refined against the full-resolution picture (§4.7).

**Route B, kept whole: the user's own ComfyUI with a CK2 node pack** (§4.11; the first plan's C0-C5 as sessions B0-B5). The only
runtime Corridor validates (CUDA bf16; §2.1), native resolution with fused attention. It is **(a)** the plan's fallback
for 0.1.52 on a no-go at Stop A or without Corridor's written yes to hosting by I8, and **(b)** otherwise the phase 2
option *Full resolution on your ComfyUI* for the final key, built only if Stop B shows the refined in-app matte too
soft on the user's pictures.

**Not a route:** Comfy Cloud (no node; §2(b)), fal / Replicate / any paid host (§2(b)), v1 (§2.1), onnxruntime-web in
the renderer (it shares the GPU and the heap with the editor's tiles; `onnx.md` §7), a CUDA or TensorRT helper
program (no prebuilt provider on Windows; large engineering).

**Why the spike still comes first:** the user chose in-app first against the plan's recommendation (2026-10-24); the
in-app mechanism has a documented prior of failure (B5's 24.7 GB, LaMa on DirectML, no export above 1024 px, WebGPU
experimental), and the user's standing rule is to measure a mechanism before building on it. So I0b measures and Stop A
decides; the sessions I1-I7 are written for a go, and §4.11 says what happens on a no-go. The "in-app first" design's
landing details (bands with `"add"`, no document-sized canvas), its hint-quality table and its registry hardening are
taken as written.

### 4.2 The spike (I0b, Stop A): measurement only, no app code

**The set:** Nucito's fp16 set (`Nucito/corridorkey-web@1ae72ca`, 2.43 GB) into a scratch folder (the user's yes is
given); its `manifest.json` names each graph's inputs and dtypes and the 18 buckets up to 1024 × 1024 (the list of
non-square buckets is read there), **but not how to feed them**. **The harness's first step** is therefore a read of
Nucito's README and JS loader for the pre- and post-processing of every graph (`rgb` as display sRGB or the asinh code;
NCHW or NHWC; the C-RADIO / MoGe / RVM normalisation and whether `foundation_stats`' mean / std sit inside or outside the
graphs; the hint's range and `hint_quality`'s shape; RVM's zero state), written into the harness as a **documented
table** and checked against upstream's `runtime.py` / `color_utils.py` (`pipeline.md` §2-3); without it a parity failure
would read as a no-go of the route when it is a pre-processing mismatch. **The harness:** `tools/ck_spike/` (a small
Electron entry started with `./node_modules/.bin/electron tools/ck_spike/main.js --set <dir> --provider dml|webgpu|cpu
--ort <module dir>`, which forks a `utilityProcess` running the graphs and prints one JSON row per measurement;
committed, it is a measurement tool like `tools/w0_bench.py`), onnxruntime-node 1.29.0 as installed and **1.30.0 in a
copy of `node_modules`** in the scratch folder (`onnx.md` §2: 1.30.0 is the latest stable; MarcelineVPQ's "ORT ≥ 1.31"
is a dev build and not an option); `--ort` hands the module directory to the utility process (an argument or env), which
does `require(path.join(dir, "onnxruntime-node"))`, since `utilityProcess.fork` resolves modules from the script's own
location (§2.4); **every JSON row records `ort.env.versions.node`**. The spike **feeds I0a's bucket-sized input PNGs byte
for byte** (the files the reference consumed, §5 I0a), never its own resample of the still. The user's ComfyUI idle or
after Free VRAM first (the 125 s paging precedent, `HELPERS.md:370-374`). **Memory:** private bytes from
`process.memoryUsage()` in the utility process and the main process; **GPU memory per process** from Windows' counters
(`Get-Counter '\GPU Process Memory(pid_<pid>*)\Dedicated Usage'` for the utility process's pid, sampled every 250 ms by
the harness, plus `'\GPU Adapter Memory(*)\Dedicated Usage'` as the card's total, both recorded); `nvidia-smi`'s total as
a cross-check only (per process it answers `[N/A]` here, §2.4).

**Per provider (dml, webgpu, cpu):** the session created at all inside the utility process (DirectML and WebGPU device
creation there is unverified); the nodes placed on the CPU (ORT verbose placement, `logSeverityLevel 0`), per graph;
load seconds per graph, cold and with the OS cache warm; private bytes after load and after one run; the process's GPU
dedicated usage; run seconds per part at the 768² and 1024² buckets, with and without a hint; the hint loop (stage 1 +
2 on cached features, ten runs, median) at 768² and 1024², **timed twice: the model time inside the utility process,
and post → answer in the main process** (the two IPC copies are part of what the person feels; I5 adds the window's
round trip); **parity per graph** against **I0a's reference of the same still at the same bucket** (the vendored
upstream runtime under bf16 autocast on the user's card, saved as float arrays): the three /64 feature maps, the baton
and the raw 4-channel stage-2 logits each get a row, so a failure names the graph and its pre-processing, not the route;
the size ladder 384 → 512 → 768 → 1024 over Nucito's buckets with seconds and memory per step (how time and memory grow
is what 1536 and 2048 are extrapolated from; those two are **measured at I1 on the own export**, Nucito's set stops at
1024); `kill()` giving private bytes and GPU memory back; the CPU provider's seconds per still at 768² (the honest cost
of a fallback, and whether fp16 runs on the CPU at all: it upcasts, `onnx.md` §6); NaN / Inf on the blown-highlight
still (fp16 activations where upstream runs bf16, `pipeline.md` §5: PR #10 chose bf16 on MPS because fp16 overflowed on
scene-linear highlights; Scumble's inputs are 8-bit sRGB, so the input code is bounded, but stage-2 activations and the
fg logits on speculars are where fp16 would first break).

**Go** (all on one GPU provider): all five graphs load; CPU-placed nodes ≤ 5 % per graph and none inside the attention
blocks; **parity logits to logits, in the model's own code, no decode in the harness** (the decoded check belongs to I3's
`keycolor_test`): per graph the feature maps and the baton within fp16 noise of the reference (recorded, the threshold set
from the first run's spread), the stage-2 logits' alpha channel MAE ≤ 2e-3 and max ≤ 0.03, the fg channels (asinh code)
MAE ≤ 0.01 over the picture, and **an edge-band row** on 0.05 < alpha < 0.95 (hair and motion blur, where the unmixing
matters): alpha MAE ≤ 5e-3 and fg MAE ≤ 0.02 there, so a broken unmixing at the edge cannot pass; no NaN or Inf, the
blown-highlight still included (the reference is itself a bf16 autocast run, so the research's 1e-3 / 0.02 would fail on
the reference's own noise, inferred; Nucito's claimed 0.002 against fp32 is unverified); the hair edge on the user's
plate the same by eye at 100 %; a still at 1024² ≤ 3 s warm (features + stage 1 + 2) and ≤ 15 s cold after the load; all
five graphs loaded in ≤ 20 s cold; the process ≤ 10 GB private bytes after a run and **its GPU dedicated usage ≤ 8 GB
after a run and at 0 within 3 s of `kill()`** (the counters above; private bytes back in the same 3 s); **the hint loop
≤ 250 ms end to end** (post → answer in the main process, the model time as one row) at the working size, ≤ 150 ms
allowing a preview that follows the brush dab by dab. **One rule for the bucket:** the working size *is* the live bucket,
chosen here as the largest bucket that meets the loop budget on the proven provider (1,024 if it does, else 768), one
resident bucket per picture; a larger bucket only for Apply when the setting asks (§4.7 point 2). **Stop A also names
the ORT version the engine needs**; a go only on 1.30.0 (or on its WebGPU provider) adds the session I0c (the exact pin,
the helper gates again, the packaged exe's `require` from the asar) before I1. **No-go:** no GPU provider meets the
list; the in-app route stops here with its numbers in `docs/measurements/ck_i0b_<date>/`, the plan says so, and Route B
(B1-B5, §4.11) becomes 0.1.52. **A go with conditions** (one provider only, a bucket cap below 1024, memory close to the
limit) is recorded as the engine's readiness table (§4.8) and the working-size default, **but only as the gate for
starting I1**: the table and the default that ship are written from I1's numbers on the own export (§4.3), not from
Nucito's graphs, which no user runs.

### 4.3 The export question (I1, on a go)

**Nucito's set is the spike's test set, not what ships:** fixed buckets to 1024, a third-party host one day old, C-RADIO
without NVIDIA's `Notice` file, licence "other" (`licences.md` §2: "a reference, not a source"). **Scumble's own export,
built on the dev machine, is what ships** (decided here, §6: the facts above leave no other candidate, and a dev-side
venv that never reaches the app or the repo is within CLAUDE.md's rule; the venv's disk use is said in one line in chat
before I1 installs it, as a download is): a Python / Torch venv in a scratch folder (about 3 GB; never bundled, never in
the repo), the fp32 sources read from `models/corridorkey2/` of the user's ComfyUI after I0a (no second 5.1 GB; the dev
machine and the ComfyUI machine are this PC, `F:\Comfyui`), fp16 at **opset ≤ 21** (DirectML's kernels stop there),
**static buckets** (DirectML recompiles on a shape change, `HELPERS.md:311`), external data per component shared across
the buckets (Nucito's layout), C-RADIO fp16 tried first and kept fp32 (1.72 GB) only if the parity check shows the error
MarcelineVPQ saw. **Two rungs:** (1) the **fused export** with `com.microsoft::MultiHeadAttention` (registered by
DirectML, flash on WebGPU; `onnx.md` §5) at 768, 1024 and, where I1 measures them inside the spike's memory limits on the
passing provider, 1536 and 2048 on the long side, portrait and landscape; (2) **the middle rung, a decomposed own
export** in Nucito's recipe (opset 17-21, default domain only) at the spike's buckets ≤ 1024, which needs no fused
kernel and no patch beyond the five known ones: it ships with the notices if MHA cannot be emitted (the fusion failing on
CK2's RoPE'd Swin / CSwin attention, or MarcelineVPQ's `engine-rs/export` scripts under a non-permissive licence) or
fails parity on the provider, and 1536 / 2048 wait for a later update. **The MHA attempt is gated on the scripts'
licence, read in I1's first hour**: with the scripts I1 is one day; without them, own scripts from upstream's module
structure (mask-free shifted windows, 4D attention, the C-RADIO position grid on portrait inputs, the MoGe position
encoding, `value_info` dropped) are two to three days, and the decomposed rung comes first so that a shipping set exists
before the fusion is tried. The scripts stay out of the repo (`dist/ck_export/`, untracked) until Corridor's answer 1
(§3.1); the recipe (versions, opset, patches, buckets, parity per bucket) goes to `docs/measurements/ck_i1_<date>/export.md`.
The set lands in `dist/ck_onnx/<version>/` (untracked, about 2.5-3.3 GB) with a `manifest.json` (graph, inputs, dtypes,
bucket, sha256 per file) and the notices (§3.3). **I1 is done** only when **Stop A's whole go list passes again on the
own export** at 768 and 1024 on the same provider (placement, load, private bytes, GPU memory, run seconds, the hint
loop end to end, `kill()`), recorded in `ck_i1_<date>/` beside the parity: the readiness table (§4.8) and the
working-size default are written from these numbers. If the own export fails the memory or time list where Nucito's
passed, the decomposed rung is tried before the route is given up; if both fail, Stop A is re-opened with the numbers
(§7 "The export").

**Hosting needs Corridor's written yes** (question 2 of §3.4, asked in the thank-you reply of 2026-10-24). On a yes: a
Hugging Face repo under the user's account whose name carries "CorridorKey" (the licence's §4; the HF API gives the LFS
sha256 the registry checks; the downloader's token rule covers the host; the Store's privacy URL names Hugging Face
already), the registry entry's URLs filled at the release (question 2 of §6). On an official export from Corridor: the
registry points at it, Scumble hosts nothing, I1's set becomes the parity check of theirs. **If Corridor has not
answered in writing by Stop B, nothing is hosted by us,** and the user decides what 0.1.52 ships (§6: Route B built for
it, about four more days; wait for the answer; or release with the in-app route dormant; recommended Route B). **The
dormant surface is defined, not improvised:** a flag `keying.inAppOffered` (false while the registry entry's `url` is
null) **hides** the dialog's in-app rows, the CPU sentence, the readiness line's provider and the Settings › Helpers row;
the Image entry stays, and the dialog opens on Route B alone when that is built, else it says in one sentence that the
set is not yet available (the agent's `status.key` says the same, §4.8); the manual's in-app paragraphs and the
CHANGELOG line for the in-app route stay under `## Unreleased` (and the Store notes carry neither) until the set is
offered, so nothing public describes a live matte no user can get. The in-app route ships in the release after the
answer arrives. A documented "convert it yourself" path is not offered (Scumble never bundles or assumes Python / Torch).

### 4.4 The engine: the registry, the download, the key process

**The registry and the downloader (I2; `electron/main/onnx/models.js`, Light):** a `kind: "key"` entry `corridorkey2`
whose `files` keep their **original names in the subfolder `onnx/corridorkey2/`** of the download dir (ORT resolves
external data by the name inside the graph beside the `.onnx`; `findFile` looks per subfolder, `:89-95`; the lookup
searches that path and **never a bare `corridorkey2` in `SUBDIRS`**, which on a linked ComfyUI `models/` folder would be
pack A's fp32 set, §3.2) with `size`, `sha256` and `url` per file; **sha256 per file** computed in the counter `Transform`
(`:314-327`, which checks size only today) and a mismatch refused with the `.part` deleted; **the HF token only to
`huggingface.co` hosts** (`:298-299` sends it everywhere today; the `docs/BUGS.md` line goes in with this plan's commit,
I2 fixes it and closes the line in the same commit); **overall
progress** for the set ("file 7 of 25 · 1.2 of 2.4 GB", the sum of `files[].size`; `shell.js:2088-2090, 2136-2143` show
one file today); a **free-disk check** before the first byte (`fsp.statfs` as `docfile.js:397`); a **pre-download terms
dialog** (§3.3, `renderer/dialogs.js`) that must be accepted once per machine; `DEFAULTS.key` / `MISSING.key`
(`index.js:20, 158`), `settings.js:23` `helpers.key`, the kind label (`shell.js:2077`) and the row's licence text
(`:2079`); an entry whose `url` is null is **not offered** (no Download button, the Key dialog says the set is not yet
available) until the hosting answer fills it.

**The key process (I3):** `electron/main/onnx/keyer.js` (the class, `Lama`'s shape: `spawn`, a pending map by id,
`kill()`; **no in-process fallback**: where the process dies before its first answer the engine refuses with the reason,
it never runs on main's thread, B5), `key_process.js` (the utility process: five sessions created on the provider the
spike proved, `helpers.device` honoured as `runtime.js:19-24` does, the spike's provider first on "auto"; **features
cached per picture** under a key `node.id : hash(picture bytes at the bucket) : bucket` (the SAM key pattern,
`host.js:5090`; the hash, not `compositeVersion`, so a mask stroke on the key layer, which bumps the composite, keeps
the features), **one resident bucket per picture** (the working size, which is the live bucket; a larger Apply bucket
asked by the setting is prepared for that Apply alone and dropped after it), stage 1 + 2 per hint; **requests
coalesced in host.js**: at most one `keyRun` in flight and one pending, the newest hint replacing the pending one, Apply
cancelling the pending preview (the utility process runs one synchronous `run` at a time and answers in arrival order,
`lama_process.js:14-26`: a fast painter must not queue N runs of 150-250 ms behind one another); an `idle` timer kills
the process 60 s after the dialog closes (decided here, §6)), `keycolor.js` (pure, tested under Node: the reflect-101
padding for what the picture's edge leaves short of the bucket (§4.7 point 2); display sRGB → linear → the signed asinh
code for stage 1 / 2 and SDR RGB for the feature models; the hint as the fourth channel with `hint_quality` as a float,
−1 and zeros for none; the outputs decoded: alpha clamped to [0,1], the foreground asinh → linear → clamped at 0 → sRGB →
[0,1] → 8-bit, the despill as the generic green limit `g − (r + b) / 2` split over the other two channels, swapped to
blue for a blue screen, at the dialog's strength; all from the README's documented conventions, L509-541, as Scumble's
own code, §3.1). IPC: `helpers:keyPrepare` `{ key, image (RGBA at the bucket), bucket }` → `{ provider, ms, cached }`;
`helpers:keyRun` `{ key, hint (u8 at the bucket) | null, quality, despill, screen, ticket }` → `{ alpha (Float32Array
or Uint16Array at the bucket), fg (Uint8Array RGB, sRGB), ms, provider, ticket }`; `helpers:keyFree`;
through `host.helperCall` (`host.js:4814`), preload `helpers.*` (`preload.js:182-199`), `main.js:1211-1226`,
`index.js` (a `keyInstance`, `clearInstances`, `free`, `remove`, `will-quit` kill it as LaMa's is killed, `:98-153`,
`main.js:1387`). `editor.helperUsed = true` on every key, so `freeHelpers` (`host.js:5357-5362`) kills the process
before a local ComfyUI run (2.4 GB of weights beside the user's Flux on the same card: the 125 s paging precedent).

**Hardware honesty:** the engine runs on the provider the spike proved. The readiness line names it ("CorridorKey 2.0
in Scumble on DirectML, working size 1,024 px"). Where no proven GPU provider creates its sessions on this machine
(another vendor's card, an integrated GPU, a driver without DirectML), the dialog offers the CPU **with the measured
cost** ("about N s per key at 768 px on this CPU, no live preview", N from Stop A) when the fp16 set runs on the CPU at
all, else it refuses with the sentence of §4.8; a second fp32 set for the CPU is not offered in 0.1.52 (§6, decided).
Non-NVIDIA cards are **untested** by this plan (the research's WebGPU-on-Intel and DirectML-on-RDNA2 reports, §2.3):
the readiness line says "tested on NVIDIA RTX cards" until a user reports otherwise, and the manual says the same.

### 4.5 The landing (I4)

What the engine answers: the alpha and the sRGB foreground at the bucket size, despilled, exactly the layer format
once scaled to the box (§4.7). Highlights above 1.0 are clipped; negatives went to 0; for 8-bit layers that is the right
loss and it matches every other layer. No colour conversion in the window.

**A new layer with opaque foreground pixels, the matte as its layer mask** (the critics' and all three designs' pick):
full 8-bit colour (opaque bytes pass the round trip unchanged), the matte editable with P / E and inspectable with
*Show alone*, the cutout's "the matte becomes the mask" habit, the memory of the matte's box, not the document's. A
straight RGBA layer would quantise exactly the hair pixels the keyer is for; a mask on the source layer would keep the
green fringe.

The steps, in `host.keyScreen` (I4):

1. **The matte's box first, from the bucket alpha:** the alpha's bounding box at the bucket (threshold > 0), scaled to
   box coordinates, grown by one bucket pixel plus 2 px and clamped to the box. **The layer is created at that box** and
   everything after scales, refines and writes inside it only: for a key without a selection the box is the whole
   picture (§4.7 point 1), and a whole-box pass at 15k × 10k would hold 600 MB of foreground and 150 MB of alpha before
   the trim (`app.md` §6), against §1's promise that a 4k subject on a 15k photo costs a 4k layer. Pixels outside the
   matte are the model's noise under a zero mask; dropping them saves memory and makes the layer behave like a cut-out
   when moved (the user's answer: trim). `addLayer` takes `x, y, w, h`; `objectInput` already reads layers smaller than
   the document.
2. **Scale to the matte's box, in bands, off the main thread where it costs:** the **alpha** goes through `key_refine`
   (I6, §4.7 point 3): the app-only worker gets the small float alpha at the bucket, the band's full-resolution picture
   rows with a halo of at least 2r rows above and below (`readBox` with the margin, `upTo` for Re-key), upsamples the
   alpha bilinearly **in floats** (never through a canvas, which would quantise it to 8 bits and resample it with the
   canvas before the filter), runs the guided filter, trims the halo and answers u8 rows; until I6 lands, the same
   worker answers the bilinear rows without the filter. The **foreground** is drawn scaled into 256-row band canvases (a
   small canvas drawn scaled into a band of the layer's box; never a whole-box canvas, never `realism.scaleAlpha`, which
   allocates `ow × oh × 4` bytes, `realism.js:425`) and written as it is (bilinear; the mask carries the edge).
3. **Write the pixels:** `Layer.empty(w, h)` (`inpaint_tiles.js:785`), then per band an `ImageData` of the band's RGB
   with A = 255 through `writeRect(img, 0, y)` (`:1406-1413`, the copy path); on the canvas backend the same writes into
   a canvas of the layer's size.
4. **Write the mask:** a fresh `Mask` of the layer's own pixel size (as the PSD import lands a layer with its mask,
   `inpaint_canvas.js:16881`; I4 confirms the mask's coordinate space in `drawPixelsInto`), filled per band with
   `combine(bytesSource(alpha, 0, y, w, bh), "add", MASK_RGB)` (`inpaint_raster.js:396`; **`MASK_RGB`, `:345`, since
   `combine`'s default colour is the selection's red**, §2.4, and the I4 gate compares the bytes with the other masks'):
   **never `"replace"` per band**, which clears the bands before it (§2.4; the logit path's pattern,
   `inpaint_canvas.js:7934`). The `preview` path into the selection keeps the default red.
5. **Land:** `pushUndo({ kind: "layers", label: "Key screen" })`, then `addLayer({ name: "Key", kind: "image", ref:
   null, dirty: true, px, maskPx, maskDirty: true, x, y, w, h })`, moved to directly above the source layer (its index
   + 1) with `moveLayer(id, delta, { undo: false })` (`:18760`), or above the base when the base was the source; `ref:
   null` and both dirty flags, so `syncLayers` uploads the pixels and the mask (§2.4: without them a restart loses the
   matte). The Match row is preset to source "underneath" at strength 0 for the session (not stored: `getValue` drops
   `match` at 0, `:24477`). **The `key` record** (`{ box, bucket, screen, despill, trust, source, provider, hash }`) is
   kept **on the layer object for the session only**, not in the document (decided here, §6: `getValue` and the restore
   name every stored field, §2.4; persisting it would be a `.scumble` field, Full tier, and a change to a shipped file;
   the cheaper match for 0.1.52): *Re-key* reads it while the session holds it, and after a restart falls back to the
   layer's bounds grown by §4.7 point 1, screen / despill / trust from `DEFAULTS.key`, the hash recomputed by one
   `keyPrepare`; the dialog then says *Re-key from this layer's bounds* and the manual states it. When the source was a
   layer, `visible = false` on it in the same step (`snapshotLayer` carries `visible`). **When the source was the base**
   (it cannot be hidden), a **mid-grey Fill layer** joins the same step between the base and the key, in this order:
   `addFilterLayer("fill")` (`inpaint_canvas.js:15271`), then `layer.params.color = "#808080"; layer.name = "Grey";
   this.markFilterChanged(layer)` (the fill was seeded from the paint colour and named `Fill N`, §2.4), `moveLayer` under
   the key layer, `activate` the key layer (`addFilterLayer` activated the fill), **and the key's status set last** (the
   fill wrote "Fill N added. It covers everything below it ..."). Procedural on tiles, so it costs no pixel memory at 15k
   there (a real W × H canvas on the canvas backend, §2.4); the user's answer 4. The status says "a grey layer sits under
   the Key layer: replace it with your background". The dialog's Source row carries the other option, *Leave the base
   as it is*, for the user who wants the plate under the key.
6. **Status:** "Key: N % of the box kept, in S s in Scumble (CorridorKey 2.0 on <provider>, <screen> screen, <hint>;
   keyed at <W> px, refined)" plus `slowHelperHint`'s advice where it applies, and the log line ("refined" only once I6
   is in and its 15k cost is recorded, §4.7 point 3). Cancel from the title row, a closed tab, the process dying mid-run
   ("the keyer stopped: <reason>", red) add nothing else.

**The source pixels.** *Visible picture* (default): the composite inside the box through `pictureInputBox`
(`host.js:5235-5261`, filters skipped, `forRun: true`). *Active layer*: the layer's own pixels inside the box at the
bucket's scale, read from its levels like `cutoutInput` with the mask applied like `objectInput` (`host.js:4899-4967`),
for a subject generated on flat green over another picture. A filter, text or reference layer active: the option is
disabled with the reason. **Re-key** reads the picture under the key layer: the engine still holds the features under
the `key` record's `hash` in the common case (nothing is read); when it does not, `pictureInputBox` gains an `upTo` it
passes to `sampleRegionSettled("image", box, s, { forRun: true, skipFilters, upTo })` (and to `flattenToCanvas` on the
canvas backend), with `upTo` the index of the grey layer or of the key layer, whichever is lower (§2.4: the composite of
the layers below that index only). **Nothing is hidden and shown again**, so no thumb, `compositeVersion` or undo
question arises.

**Stated limitations (the manual):** Scumble composites gamma-encoded 8-bit bytes with no linear conversion; a matte
made for linear-light "over" shows soft edges slightly differently from a linear compositor; every mask in Scumble
behaves so and this is not changed here. Speculars above white are clipped.

### 4.6 The hint and the live loop (I5)

| Hint source | Read at the bucket | Trust sent |
|---|---|---|
| the selection (brush, quick mask Q, wand, shapes, SAM click, *Select by text*, Select by depth / range) | `selectionCanvasSettled(box, scale, w, h)` on tiles (the mask's mip levels, no 600 MB mirror); `sel.drawTo` into a **crop-sized** canvas with a transform on the canvas backend (the depth edit's shape, `inpaint_canvas.js:13666-13680`); the red-alpha canvas becomes the u8 hint plane | the dialog's **Hint** row: **Rough (0.5)** by default (a brush, wand, shape or quick-mask selection is a loose scribble in the model's own words: hashu786 `nodes.py:62-66`, upstream README L188-198); **Automatic (0.75)** preselected when `selectionLabel` is set (the selection came from *Select by text*, `inpaint_canvas.js:2212`); **Clean (0.95)** |
| the key layer's own mask after P / E (*Re-key with this layer's mask*) | the layer mask at the bucket as `objectInput` reads a layer's mask, **at the stroke's end** (a mask stroke lives in a `StrokeBuffer` until pointer-up and `objectInput` refuses the tiled read meanwhile, §2.4) | 0.95 |
| an agent's `select_mask` | becomes the selection, then as the first row; **binary** (`commands.js:1031-1040`): the description says a soft hint needs a layer mask (`set_mask from_layer`) | as given, default 0.5 |
| none | `hint_quality` −1 and a zero plane, the model decides | — |

A feathered selection is a soft hint in [0, 1], which CK2 takes as it is. Polarity (white = subject) is checked at I3's
parity test against I0a's reference.

**The live loop, and what it needs of the shipped files (question 8, re-decided):**

- **The box and the features are fixed when the dialog opens:** the selection's bounds then (grown, §4.7) or the whole
  picture; `keyPrepare` runs once (the picture at the bucket, the three feature models) and the overlay shows the first
  matte. Strokes outside the box do not grow it; the dialog says so and offers *Refit the box*, which re-reads the
  bounds and prepares again.
- **A stroke's end** reaches host.js today: `host.on("changed")` (`host.js:4347-4355`) fires from `notifyChanged` at the
  end of `markSelectionChanged` and `markMaskChanged` (`inpaint_canvas.js:14942-14960`, `:16292-16313`, `:24392-24395`);
  the dialog's loop compares `editor.selectionSeq` (`:2236`, `:14952`), or the hint's own bytes' hash for a mask hint,
  reads the hint at the bucket (`selectionCanvasSettled`, a few ms from the levels), sends `keyRun` with a **ticket**,
  and drops any answer whose ticket is stale (relight's quick maps' `seq`, `:23327-23460`). **No shipped file changes
  for this.**
- **While a stroke is going, the selection brush and the quick mask are followed dab by dab** through
  `host.pluginPointer`: while the dialog is open host.js wraps its own method (or listens before delegating to the
  plugins) and, on `"move"` with `editor.pointer.kind === "selpaint"`, reads the hint and queues a run, **returning false
  so the brush goes on** (`inpaint_canvas.js:6529` calls it on every pointer move before any brush branch, §2.4; the
  selection's levels are current after each dab). Throttled to the measured cadence. **No timer poll, no hook in a
  shipped file, no node build.** Mask strokes (P / E on the key layer for Re-key) are followed **at the stroke's end**
  (`markMaskChanged` → `host.changed`), since the stroke lives in a `StrokeBuffer` until pointer-up (§2.4); mid-stroke
  follow for Re-key, through the pass path that composes the buffer (`layerWithStroke`), only if I5's hand test asks
  for it, measured, not asked.
- **Requests are coalesced** (§4.4): one `keyRun` in flight, one pending, the newest hint replacing the pending one;
  Apply cancels the pending preview. **The cadence that counts is end to end** (the hint read from the levels, the two
  IPC copies, the window's draw): I5 records post → answer in the window beside the model time, and Stop A's budgets
  (§4.2) are end-to-end figures.
- **The overlay** is drawn by host.js inside its own `pluginOverlay(editor, ctx)` (`host.js:1219-1222`, called from
  `drawOverlays` on every frame with the view transform applied, `inpaint_canvas.js:4757-4766`): the bucket's alpha as a
  tinted canvas (the matte in a skin colour at about 50 %, the background dimmed) drawn scaled over the box in image
  pixels, under a straighten preview turning with the picture; `editor.drawSoon()` (`:22800`) after each answer. Screen
  only: no export, screenshot or run carries it (§2.4). `drawSoon` is rAF-based, so a hidden or occluded gate window
  never draws the frame: the I5 gate asserts the dialog's state (the stored matte, its ticket and box), never a frame.
  **No shipped file changes for this.**
- **What stays a shipped-file change and is deferred to a later update:** a layer-row or context-menu entry for Key /
  Re-key (`inpaint_canvas.js`, with `host.keyingSupported: false` in the node's `js/host.js`) and a `selectionOrigin`
  field at the `markSelectionChanged` sites that would set the trust row by tool. The Image menu and the dialog carry
  0.1.52; the live overlay makes the trust row less important (the person sees the matte and picks).
- **Apply** (*Key*) runs the final key through §4.5 at the working size, or at the larger bucket when the setting asks
  and the provider has it (the dialog then says the final differs from the preview), then the refine. Escape or Close
  drops the overlay and the tickets; the engine stays warm until the idle timer. Where Stop A gave a loop above 250 ms
  end to end, the loop still runs per stroke's end and the dialog says "the matte follows each stroke after about N s";
  the stage-1 `alpha_aux` at /2 as a cheaper mid-stroke preview (§2.1) is the next step if stage 2 is the cost, measured
  first.

### 4.7 Resolution policy

1. **The box.** With a hint: the selection's bounds grown by context like Generate's crop plan and the Remove tool's
   crop (`renderer/editor/inpaint_remove.js:14-23`): the longer side times 1.5, at least the smallest useful bucket's
   side (768 px; upstream pads to 128 and a 128 px side failed in one export), **then grown to the chosen bucket's
   aspect** (more picture context, as Generate's crop plan does), clamped to the picture. Without a hint: the whole
   picture.
2. **The working size.** The working size **is** the live bucket: chosen at Stop A as the largest bucket that meets the
   loop budget end to end on the proven provider (**1,024 px on the long side if it does, else 768**; the setting
   *Settings › Helpers*, "Key screen: working size" offers the buckets the set has and I1 allowed on this provider); one
   resident bucket per picture, so the features are computed once and DirectML compiles one graph set (a shape change
   recompiles, `HELPERS.md:311`), and the matte the person paints against is the matte Apply lands. The box is fitted
   into the **bucket** whose aspect is nearest and whose long side is the working size, read at that scale straight from
   the tile levels (`pictureInputBox`); **reflect-101 padding only for what the picture's edge leaves short** (upstream
   pads at most 127 px to reach a multiple of 128; mirroring hundreds of pixels of picture to fill a bucket's aspect would
   put a mirrored subject at the border for the matte to key, out of the model's training distribution: the box is
   grown instead, point 1). A larger bucket is used **for Apply alone** when the setting asks for it, and the dialog
   says the final then differs from the preview. `keying_test.js` tests the box plan with the aspect growth and the
   edge-only padding at 1k, 4k and 15k.
3. **Back to the box, refined (I6): `key_refine` is the whole alpha path, in an app-only worker.** The small float alpha
   at the bucket goes to the worker with the band's full-resolution picture rows plus a **halo of at least 2r rows above
   and below** (`readBox` with the margin; `upTo` for Re-key); the worker upsamples the alpha bilinearly in floats, runs
   the guided filter, trims the halo and answers u8 rows for `bytesSource` (§4.5 step 2). The halo is what keeps the box
   blurs from reading across a band seam: without it the refined matte gets a visible line every 256 rows, exactly the
   seam point 6 calls worse than softness. Boxes whose refine fits one array (≤ about 16 MP; `HELPERS.md`'s 3.4 s at
   11 MP) run **unbanded**. **The guide is specified, not "the picture":** `guidedFilter` takes one grey channel, and on
   a green screen the screen's luminance is close to skin and mid tones, so a luminance guide finds no edge where the
   colour edge is strongest and can snap the matte to a shadow or a fold; the guide is the **chroma distance to the
   detected screen colour** (one channel, cheap, sharpest where the key is), or the three-channel guided filter, chosen at
   I6 by the edge measurement and recorded with it. The radius and eps come from the upscale factor (about 15-30 px at
   15k / 1024). Without the refine an in-app final at 1 MP for a 24 MP photo is too soft; `guidedFar` cannot be reused as
   it is (`inpaint_depth.js:269`, §2.4). The foreground stays bilinear (the mask carries the edge). **Where it lives (the
   real choice of question 8, weighed in §6):** (a) a shipped pool op `key_refine` in `inpaint_worker.js` plus a shipped
   `inpaint_keymatte.js` (the node gets the op for free; one more node build in the release; a merge with the kernel
   branch's moving `inpaint_worker.js`), or (b) **an app-only module worker `renderer/editor/keyworker.js`** owned by
   host.js (started on the first key as `stitch.js:822` starts `stitch_worker.js`, imported from no shipped file;
   `keymatte.js` pure and tested under Node beside it; `boxBlurs` imported from `px/kernels.js` and `guidedFilter` from
   `inpaint_depth.js`, both shipped files imported, not changed): no shipped-file change, no node build, no merge
   friction, the op not in the node. **(b) for 0.1.52.** The kernel plan's K24 (`guided_far` in Rust) is where the filter
   would move later. **This is a core session (I6), not an option**, and the status sentence says "refined" only once
   I6's 15k cost per band is recorded in `ck_i6_<date>/`.
4. **Full resolution on your ComfyUI (phase 2, Route B):** where a ComfyUI with a CK2 pack is connected, the dialog's
   final key may run there natively up to Route B's cap (§4.11); built only if Stop B shows the refined matte too soft
   on the user's pictures. The live preview stays in-app in every case.
5. **Refused by size:** nothing. Refused before anything is read (one status sentence, `realismWholeCheck`'s shape): the
   set not downloaded, no provider usable (or the CPU declined), the engine busy, a run going on the document
   (`resizingRun`, `providerPending`), the document loading, no picture, a source layer without pixels.
6. **Why not tiles:** tiling breaks the global attention the model relies on; seams in a matte are worse than a softer
   matte refined by the picture. The depth path's Detail grid fuses tiles because depth is smooth; a matte is not.

### 4.8 The command, the assistant, settings, readiness

- **`key_screen`** in `renderer/commands.js` after `realism_pass` (`:1479-1502`), the shape of `cutout_layer`: params
  `source` ("picture" default, or a layer), `screen` auto | green | blue, `hint` selection | mask | none, `trust`
  0.5 | 0.75 | 0.95 (default 0.5), `despill` 0-1 (0.5), `preview` (the matte **into the selection** in bands, `combine`
  on `this.sel` with `"add"`, one `selection` undo step as `selectLogits` does, nothing landed), `rekey` (a key layer's
  mask as the hint at 0.95; pixels and mask replaced under one `layerfull` step from the `key` record while the session
  holds it, else from the layer's bounds as §4.5 step 5 says), `timeout` (300).
  Returns `layerSummary`, `seconds`, `box`, `workingSize`, `provider`, `status`. The description says a `select_mask`
  hint is binary. The tool count 116 → **117** (`README.md:83, 303`, `docs/MCP.md:306`), `docs/COMMANDS.md` by
  `tools/commands_doc.py`, the `.mcpb` by `tools/mcpb_build.js`.
- **`status`** gains `key` readiness as it has `realism`; `list_recipes` is untouched (this is not a recipe).
- **The assistant:** `key_screen` in `RUNS` (`policy.js:21`), an ask card with the screen, hint and trust; `preview`
  counts as a run too (it changes the selection).
- **Settings** (`electron/main/settings.js` DEFAULTS, the `realism` precedent at `:20`): `key: { screen: "auto",
  trust: 0.5, despill: 0.5, preview: true, workingSize: <Stop A's bucket, 1024 or 768>, greyUnderBase: true, timeout:
  300 }`; `keying.fillValues` as `realism.fillValues` (`realism.js:53`). `helpers.key` (`settings.js:23`) names the set,
  `helpers.device` the provider policy. `keying.inAppOffered` (§4.3) is derived from the registry entry's `url`, not a
  setting.
- **`host.keySupport()`**, from `keying.engineSupport({ status, provider })` (the helper status of `index.js` `status()`
  `:55`: the set present, the provider the process reports, the CPU cost). The readiness sentences (the first row is the
  dormant case of §4.3: with `inAppOffered` false the dialog shows none of the in-app rows, the CPU sentence or the
  Helpers row, and the sentence is what the agent's `status.key` and the dialog's one line say):

| State | Sentence (status kind) |
|---|---|
| the set not offered yet (no URL; `inAppOffered` false) | "Key screen: the CorridorKey 2.0 set is not available for download yet." (info) |
| the set not downloaded | "Key screen needs the CorridorKey 2.0 set (about 2.4 GB): download it in Settings › Helpers (Help › Scumble help › Key screen)." (warn; the dialog's download block) |
| no proven GPU provider, the CPU runs it | "Key screen runs on the CPU on this machine: about N s per key at 768 px, no live preview. Tested on NVIDIA RTX cards." (warn; *Key* stays) |
| no provider at all | "Key screen could not start CorridorKey 2.0 on this machine (<the provider's error>)." (error) |
| the engine busy / a run going | `RUN_GOING_TEXT`'s shape (plain) |
| ready | the dialog names the provider and the working size |

- **The entry:** *Image › Key Green / Blue Screen...* (`electron/main/main.js:712-727`, after the Realism Pass; main has
  no engine state, so it is never greyed), dispatched like `realism-pass` (`renderer/shell.js:3175`) to a dialog of the
  app's own (`renderer/dialogs.js`, item 25).
- **Screen Auto:** the mean colour of the box's border ring read from the bucket's bytes, taken outside the hint where
  there is one; B > G means blue; when the ring is neither clearly green nor blue (a subject touching the frame, no
  hint on a tight picture) the dialog asks instead of guessing.

### 4.9 The process model

The engine runs in an Electron **utility process** (`lama.js:76-88`, `lama_process.js`), never on main's thread (B5:
24.7 GB after one BiRefNet run; a worker thread killed inside a native call crashes, `lama.js:16-24`); `kill()` gives
private bytes and GPU memory back within seconds (a go criterion, measured with the GPU counters of §4.2);
`clearInstances` / `will-quit` / `free()` / `freeHelpers` kill it; `editor.helperUsed = true` on every key; **the idle
timer kills it 60 s after the dialog closes** (decided here, §6: the collision with the user's ComfyUI is handled by
`freeHelpers`, the cost is a Stop A number, and the readiness line says "the keyer frees the GPU a minute after the
dialog closes"). The process runs one synchronous `run` at a time, so host.js coalesces requests (one in flight, one
pending, §4.4). The answers cross IPC at the bucket's size (≤ 28 MB at 2048², far under G2's 500 MB); the scaling to the
box, the refine and the landing run in the window and the app-only worker in bands. A key holds the document like a
provider run (`editor.providerPending`, the title row's timer and Cancel, `_providerRuns`); closing the tab ends it; the
process dying mid-run is one red status sentence and nothing landed.

### 4.10 Where it lives

A branch **`corridorkey` off `main`** in a worktree (the user's answer 2). **Where the plan lives first:** this file, the
five research files and item 49's CLAUDE.md text exist only on `wasm-kernels` (`5d70442`, and this rework uncommitted at
the time of writing; `main..wasm-kernels` is 16 commits, `wasm-kernels..main` none), so a branch cut off `main` would
start without its own plan. **Done 2026-10-24 instead of a cherry-pick** (CLAUDE.md and BUGS.md differ between `main` and `wasm-kernels`, so a
cherry-pick conflicts): the rework committed on `wasm-kernels`; `corridorkey` cut from `main` (`2d9a353`) in the worktree
`.claude/worktrees/corridorkey`; its first commit takes this file, the research folder, `CLAUDE.md` and `docs/BUGS.md` as
they are on `wasm-kernels` (docs only), so both branches start from the same text and `origin/main` does not move until
the release. The branch's CLAUDE.md hand-overs go **only into item 49's block and the "Where things stand" line**, so
the merge after 0.1.52 conflicts in one place. **The worktree's dev instance:** the worktree gets `node_modules` as a
junction to `F:/canvas/node_modules` (the native modules `onnxruntime-node`, `sharp`, `@comfyorg/sdk` resolve from the
app dir; memory "mutation round on a copy"), started as `F:/canvas/node_modules/.bin/electron <worktree>
--remote-debugging-port=9571 --user-data-dir=<scratch> --no-comfy`, so the `wasm-kernels` checkout stays untouched;
pushed after every session. **The dev machine and the ComfyUI machine are this PC** (`F:\Comfyui`): no copy of the
5.1 GB anywhere. **Released as 0.1.52 on the user's word after I8** (or after B1-B5 when Stop B adds them, or as Route B
alone on a no-go or by the user's Stop B decision without the hosting answer): the CHANGELOG section and `package.json`
committed on the branch, **`corridorkey` merged into `main` (a fast-forward), main pushed (CI builds main on the
push), the tag `v0.1.52` on `main`** (the draft; the tag is on main, as every release but the 0.1.33 hotfix), then the
chain of `docs/RELEASING.md`; afterwards `main` merged into `wasm-kernels` as 0.1.51 was (`PLAN_WASM_BUILD.md` §7 "G2").
The one shared file with the kernel branch is `host.js` (K0a's marks in `saveExport`; `keyScreen` is one method beside
`realismWhole`); `inpaint_worker.js` is **not** touched (the refine lives in an app-only worker, §4.7 point 3), so the
K-sessions' routes and ops there merge without friction. `main` stays the release state between sessions. Two costs of a
release in between, named: the Store backlog (the 0.1.48-0.1.51 MSIX uploads are still the user's open drag and drop;
the 0.1.52 notes cover them) and the CHANGELOG merge.

### 4.11 Route B: the user's ComfyUI with a CK2 node pack (kept whole; sessions B0-B5)

**When it is built:** as the whole of 0.1.52 on a no-go at Stop A, or by the user's decision at Stop B without
Corridor's written yes to hosting (§4.3, §6); otherwise as the phase 2 option *Full resolution on your ComfyUI* after
Stop B. Pack A is installed at I0a in either case (the parity reference; on the user's word after the code check), so
Route B starts from a running pack; should the user decline it, B0 installs it then.

**The pack table and the graph.** `renderer/editor/keying.js` (new, **app-only**: not in `tools/build_node.py` FILES,
like `realism.js`; pure, tested under Node) holds a table of the two packs in the shape of `CUTOUT_BACKENDS`
(`inpaint_canvas.js:1257-1310`): per pack `id`, `label`, `needs` (the node classes `/object_info` must list: A
`CorridorKey2ModelLoader` + `CorridorKey2Basic`, B `CorridorKey2`), `build(refs, values)` → the graph, `output` (A
`["ck_key", 2]`, B `["ck_key", 4]`), the input names of hint / quality / despill / screen / download, `despillBlue` (A
true, B false), `evicts` (A "the auto window may unload other models", B "`unload_other_models` on by default"),
`downloadSwitch` (A `auto_download`, B none). The pack present is the one whose classes the server lists; neither class
name clashes (the `CorridorKeyKeyer` clash is between two v1 packs); `python_module` (ComfyUI `server.py:855`) is
checked only if a clash appears. **Pack A is the primary and the one run live first**; pack B's entry is written from
its README and marked unverified until a live run (Light tier, as providers built from docs).

The graph for pack A (six nodes; `keyPrompt(pack, refs, values)`):

```
ck_in       InpaintCanvasLoadRef   { ref: <the picture box, PNG> }
ck_hint_img InpaintCanvasLoadRef   { ref: <the hint, grey PNG> }          only with a hint
ck_hint     ImageToMask            { image: ["ck_hint_img", 0], channel: "red" }
ck_model    CorridorKey2ModelLoader{ weights: <spec default>, auto_download: false | true, keep_on_gpu, vram_reserve_gb: 0.5 }
ck_key      CorridorKey2Basic      { model: ["ck_model", 0], images: ["ck_in", 0], alpha_hint: ["ck_hint", 0]?,
                                     hint_quality: <the preset whose number matches the trust>, invert_hint: false,
                                     despill, screen }
ck_out      PreviewImage           { images: ["ck_key", 2] }               the rgba output
```

`hint_quality` is a combo on pack A: the module picks the option whose text carries the number ("0.95", "0.75", "0.5")
from the saved spec, else the spec's default. A copy of `withSpecDefaults` (20 lines on `host.nodeTypes()`, with a
comment naming the shipped twin in `inpaint_canvas.js:1046`) fills any required input a pack adds later, as it did for
SAM3 (issue #7); **it is not moved** into `comfyprompt.js` (app-only: the node's editor build would import a module the
node does not have; the critics' must). Pack B's graph: `CorridorKey2 { image, mask?, hint_quality: <float>,
despill_strength, window: "1/1", unload_other_models: <evicts setting> }`, `ck_out` on slot 4. `PreviewImage` writes a
temp file, so nothing lands in the user's output folder (the Realism Pass's reason too).

**The run:** the picture box and the hint uploaded with `uploadInput` (`host.js:2989`), `comfyPictureRun(editor,
prompt, "ck_out", { label, token, timeoutMs, front: true })` (`:3025-3137`), the 8-bit straight RGBA PNG decoded in
bands without a canvas (`readPng(blob, { onRows, rowsPerBand: 256 })`, `inpaint_png.js:201`, or the pool's `png_read`
as the file open uses it, `inpaint_canvas.js:683`), then §4.5's steps 2-6 (the landing is **shared** with Route A: one
`landKey(editor, { alphaBands, fgBands, box, ... })`). The net if the `rgba` output's bytes are not straight 8-bit: two
`PreviewImage` nodes on `foreground` and `alpha` through `MaskToImage`, `comfyPictureRun` learning `outputs: [fgId,
alphaId]` (one more branch in its wait, `host.js:3054-3073`).

**Resolution on Route B:** the box native while its area is at most `KEY_CAP` (default **16 MP**) and its longer side at
most **8,192** (C-RADIO's tested range at H/4), the cap a setting set from I0a's numbers (whether 16 MP is a tolerable
few seconds in normal mode on the 5090, or 8 MP is the default; §2.2 on the eight-frame estimate); scaled by one factor
above it (`realism.fitAreaSize`'s shape, `realism.js:341`), the answer brought back to the box by the app per band and
refined by I6's `key_refine`, never pack A's `process_scale` (whose upsample would send a native-size PNG back, 600 MB
for a 15k whole picture). Nothing refused by size.

**The download and the first run on the ComfyUI machine:** Scumble sends `auto_download: false`; a missing set fails in
a second with the pack's `FileNotFoundError` naming the files (`model_nodes.py:58-62`), which `keying.hint(message)`
turns into the dialog's first-run block (§3.3) with the two ways to fetch them (the pack's `scripts/download_models.py`
on the ComfyUI machine, or the loader once in the ComfyUI page with `auto_download` on). The `weights` combo of
`/object_info` is **not** a presence check (`ck_comfy/paths.py:83-92`). A switch *Let the pack download the models
(about 5.1 GB) on the first run* exists only if B0 shows the pack's `comfy.utils.ProgressBar` frames
(`ck_comfy/comfy_utils.py:57-60`) reach Scumble's bar and a Cancel leaves no interrupt flag set; then it sends
`auto_download: true` with a 2 h timeout (`comfyPictureRun`'s clock resets only while the job is pending,
`host.js:3075-3089`). **`keep_on_gpu` off by default** (the user's answer; about 4.6 GB parked on the production card
between keys otherwise), a tick in the dialog, *Keep the model on the GPU between keys*, which says that *Free VRAM*
(ComfyUI's `/free`) releases it (I0a checks that it does). Pack B downloads regardless and its `unload_other_models` is
sent as the `evicts` setting, off by default.

**Readiness on Route B** (`keying.serverSupport({ state, os, gpus, objectInfo })`, `realism.js:94-128` as the model,
`gpuGeneration` imported from there; no os check: the packs are CUDA-only, not Windows-only): not connected → "Full
resolution on your ComfyUI needs your own ComfyUI with an RTX 30, 40 or 50 card and a CorridorKey 2.0 node pack: connect
it under Settings › ComfyUI." (info); CUDA devices but none RTX 30+ → warn naming the card; no pack's nodes → "install
one there (Help › Scumble help › Key screen)" (warn); `InpaintCanvas` missing → warn; all there → the route offered,
the pack named. **No Comfy Cloud and no paid host.**

**Route B's process model:** nothing of CorridorKey runs in Scumble's process; the answer arrives over the proxied
`/view` fetch (no IPC size limit); `editor.helperUsed` is not set (no in-app model sits in VRAM).

### 4.12 The manual and the texts

A chapter *Key green / blue screen* (slug `key-screen`) in the Realism Pass chapter's shape (`docs/MANUAL.md:362-406`):
what it does, what you see (the live matte while painting), what it needs (a GPU ONNX Runtime can use, tested on NVIDIA
RTX cards; the 2.4 GB set downloaded in Settings › Helpers; the CPU's cost without one), what the download is and under
which licences, the seat clause, the hint and its trust, the Source row and the grey layer, the working size and the
refine, Re-key (and that after a restart it starts from the layer's bounds), every status sentence explained, the
gamma-compositing and 8-bit notes, the cutout as the alternative without any of it, agents (`key_screen`); Route B's
section (the pack's install steps as its README has them at the commit, dated; the Manager does not list it; what the
first run downloads) only when Route B is built. **Which texts ship in which case** (§4.3): with the set offered, the
whole chapter, the README line and the CHANGELOG line for the in-app route; without the hosting answer, the in-app
paragraphs and that CHANGELOG line stay under `## Unreleased`, the Store notes and the post say nothing of a live matte,
and the chapter describes Route B alone (if built) or is held back with the feature. README: one feature line under the
helpers. CHANGELOG `## Unreleased` lines per session, the `## 0.1.52 - <date>` section at the release. About (§3.3).
`THIRD_PARTY_NOTICES.md` (§3.3) with a hosted set.

## 5. Sessions

**Rules for every session** (CLAUDE.md "Working rules", `PLAN_WASM_BUILD.md` §1.3): one numbered section per sitting,
its commit as DenRakEiw without a trailer, **the branch pushed** (the user's rule for bigger updates), measurements
committed under `docs/measurements/ck_<step>_<date>/` (large reference arrays and the ONNX set stay untracked under
`dist/`, their sha256 in the committed summary), the hand-over line in CLAUDE.md "Where things stand", a CHANGELOG
`## Unreleased` line for what the user notices, then `/clear`. Every app gate `--offline` with the engine stubbed
(`host.helperCall` for `key*`, as the gates stub `cutout`, `tools/commands_test.py:2230-2273`); one instance at a time;
the dev instance on port **9571** from the worktree (its `node_modules` a junction, §4.10). **Every live run on the
user's ComfyUI only on their word, `/queue` checked first, own prompts taken off, never a restart; the engine's real runs
on this machine with the user's ComfyUI idle or after Free VRAM.** Stage by explicit path and check `git diff --cached
--name-status` (the checkout carries the user's untracked material). **Tiers:** the pure modules, the registry and the
request shapes Light; the engine's parity a hand-run test with the real set; the landing and the refine Normal on both
backends (pixel and mask paths) plus the gates the change touches; the UI Normal with `skins`; docs Light; nothing
Full (no Rust kernel, no `.scumble` field: the `key` record is session-only, §4.5; no compositor or export writer).
**No shipped editor file changes in 0.1.52** (the live loop through `host.pluginPointer` and `host.changed`, the overlay
through `host.pluginOverlay`, the refine in the app-only `keyworker.js`, §4.6-4.7), so **the release carries no node
build** unless a later decision puts keying into the node (§6). The behaviour sentence of §1 is repeated in chat before
I4 and I5.

Efforts in days, **inferred**.

| # | Session, goal | Files (anchors) | Tests (tier) | Done when | Effort |
|---|---|---|---|---|---|
| **I0a** | **Pack A's code check, its install, the reference keys** (the user's answer 3). **First a code read of pack A at `eeee7fa`** (a two-day-old repo by an unknown author, 0 stars, running Python inside the production ComfyUI; the clone in the planning session's scratchpad `ck_comfy/`, re-cloned if gone): every file and `requirements.txt` read for network access beyond the model hosts (HF, Google Cloud Storage), `subprocess` / `os.system`, `eval` / `exec`, pickled loads (`torch.load` without `weights_only`: MoGe's `model.pt` is a torch pickle, upstream loads it too, said as such), obfuscated or downloaded code, writes outside `models/corridorkey2/`; the diff of the vendored part against upstream `485f5e9`. **The findings to the user before anything is installed.** On the user's word: the clone pinned to `eeee7fa` into `custom_nodes`; its requirements checked with `python_embeded\python.exe -m pip install --dry-run -r requirements.txt` (today "nothing to install": safetensors 0.8.0, einops 0.8.1, timm 1.0.19, scipy 1.15.2, opencv-python 4.10.0.84 beside three other opencv builds, huggingface_hub 1.27.0 all satisfy the pack's `>=` pins; recorded in the summary; any future pin that would change a package is shown to the user as a diff against the 0.42.4 backup's `pip_freeze.txt` before anything is installed into the production Python); a restart only when the machine is free and on the user's word; the 5.1 GB fetched by the user (the ComfyUI page or `scripts/download_models.py`). `/object_info` of the pack's nodes saved to `tools/refs/corridorkey/`. **The reference keys** (the parity reference for I0b and I1): a scratch script on `python_embeded` calling **the pack's vendored upstream `corridorkey` package** (plain torch plus the utils3d shim; not `ck_comfy`, which imports `comfy_api.latest` and `comfy.utils` and exists only inside ComfyUI's process, `comfyui.md` §1), **with ComfyUI idle after Free VRAM (`/free`) with the queue empty, or stopped on the user's word** (the reference runs torch on the same card as ComfyUI's resident models: 8.1 GB used idle today, 29 GB with Flux, the 125 s paging precedent), `nvidia-smi` recorded before and after; it keys **five** of the user's stills (a green plate, a blue plate, one FLUX 3 subject on flat green, one with fine hair, **one with blown highlights or speculars**: a lit edge, a reflection, for the fp16 overflow check) at the spike's buckets (768², 1024², the box grown and padded as §4.7 points 1-2 say) and at native, with and without a rough brush hint (the hint saved beside), and writes per still and bucket **(a) the exact bucket-sized 8-bit input PNG the run consumed** (the resample stated: OpenCV `INTER_AREA`; the spike feeds this file byte for byte), **(b) the three /64 feature maps, the baton and the raw 4-channel stage-2 logits as float arrays** (float16 `.npy`), and the decoded alpha and fg as float16 `.npy` plus 8-bit PNGs, into `dist/ck_ref/` (untracked; sha256 in the summary). **If the user declines pack A after the code check**, the reference comes from upstream `infer.py` under I1's venv torch instead (the same card rule). **The Route B facts** taken while the pack is there: seconds cold and warm at 1, 4 and 16 MP through the server with the Advanced node's `info` mode string, `/system_stats` VRAM, `keep_on_gpu` and whether `/free` releases it, the `rgba` PNG read back (8-bit? straight?), the polarity of a grey hint through `ImageToMask`; the rest of Route B's probe waits for B0 | `docs/measurements/ck_i0a_<date>/summary.txt`, `tools/refs/corridorkey/`, `dist/ck_ref/` (untracked) | none (a measurement) | the findings delivered; the install pinned, the dry run recorded; five stills with hint / no hint at two buckets and native saved as input PNGs, feature maps, baton, logits and decoded arrays; the Route B facts noted | 0.5 + the user's time |
| **I0b** | **The spike, measurement only, no app code** (§4.2): Nucito's set into a scratch folder; **first the pre- and post-processing table** of every graph from Nucito's README and JS loader, checked against `runtime.py` / `color_utils.py` and written into the harness; `tools/ck_spike/` (the Electron entry with `--ort <module dir>`, the utility-process script; `ort.env.versions.node` in every row); I0a's input PNGs fed byte for byte; per provider dml / webgpu / cpu on 1.29.0 and 1.30.0: sessions, placement, load, private bytes, the process's GPU dedicated usage from the Windows counters (nvidia-smi's total as a cross-check), run seconds per part at 768² and 1024², the hint loop as model time and as post → answer in main, **parity per graph** (features, baton, logits; the edge band), NaN / Inf on the highlight still, the ladder over the buckets, `kill()`, the CPU cost | `tools/ck_spike/`, `docs/measurements/ck_i0b_<date>/` (summary, the processing table, placement logs, counter and nvidia-smi rows, parity per graph, the ladder, kill timing) | none (a measurement) | **Stop A:** go / no-go by §4.2's list; the provider; **the ORT version the engine needs**; the working size (= the live bucket) and the buckets allowed, as the gate for I1; the loop's end-to-end cadence; the CPU sentence's N. On a no-go: B0-B5 become 0.1.52 and I1-I7 are not built | 1 |
| **I0c** (only if Stop A's go is on a version other than the installed 1.29.0) | **The runtime pin:** `onnxruntime-node` pinned **exactly** to the version Stop A names (the `^` becomes an exact pin either way, as the Comfy SDK's did in S0); the helper gates again on tiles (`depth`, `maskview`, `edges`, `selection`, the cutout steps of `commands`), `helpers_test.js` for SAM2 and the matting, LaMa's CPU path once by hand; `npm run dist` and the check that the packaged exe requires the module from inside `app.asar` | `package.json`, `package-lock.json`, `docs/HELPERS.md` (the version line) | the gates named; the asar check | the pin exact; every helper green on the new version; the exe loads it from the asar | 0.25-0.5 |
| **I1** | **The export** (§4.3; on a go; the venv's disk use said in one line in chat before it is installed): the venv in a scratch folder, the fp32 sources from `models/corridorkey2/` of the user's ComfyUI, **MarcelineVPQ's scripts' LICENSE read in the first hour** (the MHA attempt is gated on it: 1 day with the scripts, 2-3 without), **the decomposed rung first** (Nucito's recipe, opset 17-21, default domain, buckets 768 and 1024) so a shipping set exists, then fp16 + `MultiHeadAttention` at opset ≤ 21 at 768 and 1024 and, on the passing provider, 1536 and 2048 measured (the ladder above 1024), parity per bucket and per graph against I0a's reference, C-RADIO fp16 or fp32 by the parity, the manifest with sha256 per file, the notices; the hosting question re-asked with the numbers if unanswered | `dist/ck_export/` and `dist/ck_onnx/<version>/` (untracked), `docs/measurements/ck_i1_<date>/export.md` and the go list's numbers | the parity run per bucket and per graph (the go thresholds); **Stop A's whole go list again on the own export** at 768 and 1024 on the same provider (placement, load, private bytes, GPU memory, run seconds, the hint loop end to end, `kill()`) | the set that ships named (fused, or the decomposed rung at ≤ 1024 with the reason); the go list green on it at 768 and 1024; the ladder's 1536 / 2048 recorded as kept or dropped with the reason; **the readiness table and the working-size default written from these numbers**; the manifest written | 1 (2-3 without the scripts) |
| **I2** | **The registry and the downloader hardening** (§4.4): the `kind: "key"` entry under `onnx/corridorkey2/` with original names (never a bare `corridorkey2` in `SUBDIRS`), sha256 per file, the token only to `huggingface.co`, overall progress, the free-disk check, the terms dialog, `keying.inAppOffered` false and nothing offered while the URL is null; `DEFAULTS.key` / `MISSING.key`, `helpers.key`, the row's kind label and licence; `THIRD_PARTY_NOTICES.md` drafted (committed with the set's hosting); the `docs/BUGS.md` token line (written with the plan's commit) closed in the same commit | `electron/main/onnx/models.js` (`:78`, `:84-95`, `:269-273`, `:292-331`), `index.js` (`:20, :158`), `electron/main/settings.js:23`, `renderer/shell.js` (`:2077-2079`, `:2088-2090`, `:2136-2143`), `renderer/dialogs.js`, `docs/BUGS.md`, `THIRD_PARTY_NOTICES.md` | Light: `node tools/scan_test.js` (ftruncate sizes: no 2.4 GB on disk), a new `tools/download_test.js` on a local HTTP server (a sha256 mismatch refused and the `.part` deleted; the token sent to an HF host and not to another; a resume; the subfolder under `onnx/`; the overall progress rows; the free-disk refusal; a null URL not offered and `inAppOffered` false), `lint`, `types`, the settings migration test | the tests green; the Helpers row shows the set with its licence and one bar | 0.75 |
| **I3** | **The key process** (§4.4): `keyer.js`, `key_process.js`, `keycolor.js`; `index.js` `keyPrepare` / `keyRun` / `keyFree`, `MISSING.key`, the instance killed by `clearInstances` / `free` / `remove` / `will-quit` and the 60 s idle timer; `main.js:1211-1226`, `preload.js:182-199`; `host.keyEngine` wrappers through `helperCall` (`host.js:4814`) **with the request coalescing** (one in flight, one pending, tickets), `editor.helperUsed`, `freeHelpers` (`:5357`); the features cache by hash, one resident bucket per picture, the provider policy | new `electron/main/onnx/keyer.js`, `key_process.js`, `keycolor.js`; `index.js`, `main.js`, `electron/preload.js`, `host.js`, new `tools/keycolor_test.js` | Light: `node tools/keycolor_test.js` (the edge pad and its inverse, the colour codes round trip within 1e-6 against README L509-541's formulas, **the decoded alpha and fg against I0a's decoded arrays** on one reference crop, the despill on known triples for green and blue, the hint plane and quality; the coalescing on a stubbed engine: ten hints in a burst give one run in flight and the last one pending); **the parity test** `node tools/helpers_test.js --key` with the real set (skipped where the set is missing): one I0a reference within the go thresholds logits to logits, polarity, private bytes and the GPU counter before and after `kill()`; `lint`, `types` | the parity test green on the spike's provider; the process gone within 3 s of a kill with the memory back | 1.5 |
| **I4** | **The landing** (§4.5): `host.keyScreen(editor, opts)` beside `realismWhole` (`host.js:3425-3575`): `keyCheck` (the refusals of §4.7 point 5, `realismWholeCheck`'s shape), the box (§4.7, grown to the bucket's aspect), the picture through `pictureInputBox` (`:5235`, gaining `upTo`) or the layer through `cutoutInput` / `objectInput`'s shape (`:4899-4967`), the hint through `selectionCanvasSettled` (`inpaint_canvas.js:9209-9225`) or the crop-sized `sel.drawTo` (`:13666-13680`), `keyPrepare` + `keyRun`, **the matte's box first** from the bucket alpha, then the scale in bands inside it (the alpha through the app-only `keyworker.js`, bilinear until I6; the foreground through band canvases), the layer and the mask (`"add"` per band **with `MASK_RGB`**, `dirty: true, maskDirty: true, ref: null`), the hidden source layer, **the grey Fill layer under a base key** (`addFilterLayer("fill")`, `:15271`, then `#808080`, "Grey", `markFilterChanged`, moved under the key, the key activated, the key's status last; one undo step), `landKey` shared with Route B, the session-only `key` record, the status and the log line | `host.js`, new `renderer/editor/keying.js` (app-only: `boxPlan`, `screenFromRing`, `fillValues`, the texts), new `renderer/editor/keyworker.js` (app-only, the bilinear rows now, the refine at I6), `electron/main/settings.js` DEFAULTS.key | Normal: a new gate `key` = `tools/key_test.py` (every gate name without a rule runs `tools/X_test.py`, `docs/TESTING.md:171-172`) stubbing `host.keyEngine` with a fixture (I0a's reference cropped to about 512 px; a synthetic one until then): the layer's bytes exactly and **the mask's bytes exactly, white where it lets through** (`MASK_RGB`, as `transformed` / `invert` / the PSD import write), the trim box from the bucket alpha, the hidden source layer, the grey layer under a base key in grey (not the paint colour) with the key's status shown, the key layer active, one undo restores all three, **an autosave and a restore bring the pixels and the mask back and Re-key then falls back to the layer's bounds** (the record is not stored), a refusal, a cancel, the scaled path within a level, a Re-key read with `upTo` leaving `compositeVersion` and the thumbs alone; on `--tiles on` and `--tiles off`; plus `editor`, `export` (a keyed layer with its mask exports to PNG, PSD, ORA); `node tools/keying_test.js` (the box plan at 1k, 4k, 15k with and without a selection, the aspect growth, the edge-only padding; the ring; the texts carry the label) | the gate green on both backends; a key end to end on the dev instance with the real engine | 1 |
| **I5** | **The dialog and the live loop** (§4.6, §4.8): *Image › Key Green / Blue Screen...* (`main.js:712-727`; `shell.js:3175`'s dispatch), the dialog (Screen, Hint + trust, Despill, Source with the base's grey / leave choice, Preview, the working-size line, the readiness line with *Key* greyed and the reason, the first-run download block with the terms paragraph; the in-app rows hidden while `inAppOffered` is false), the loop on `host.on("changed")` + `selectionSeq` / the mask's hash with tickets, **the `host.pluginPointer` wrap for `"move"` with `editor.pointer.kind === "selpaint"`** (returning false, throttled), the coalescing from I3 used, the overlay in `host.pluginOverlay` + `drawSoon`, *Refit the box*, *Re-key with this layer's mask* when a key layer is active (one `layerfull` step from the `key` record, or from the layer's bounds after a restart), the title row's Cancel through the token, Escape / Close dropping the overlay; **the end-to-end cadence** (post → answer in the window) recorded beside the model time | `main.js`, `shell.js`, `renderer/index.html`, `renderer/dialogs.js`, `host.js`, `keying.js` | Normal: the `key` gate's dialog steps (the values reach the engine stub's request; the greyed states; a scripted selection change while the dialog is open sends one preview request with the new hint and **the dialog's object holds the stored matte with its ticket and box** (state, never a frame: `drawSoon` is rAF-based and a gate's window is hidden); a scripted dab burst through `pluginPointer` gives one run in flight and one pending; a stale ticket is dropped; the re-key step: a painted mask changes the stub's input at the stroke's end, not mid-stroke, and one Ctrl+Z restores pixels and mask; the dormant case shows no in-app rows), `skins` (every skin), `editor`; one look in the app, **the user's hand on the brush with Preview on** (the dab-by-dab follow judged there; a mid-stroke follow for Re-key decided by it) | the dialog runs a key end to end on the dev instance against the stub and once with the real engine; the overlay follows the user's brush at Stop A's end-to-end cadence (recorded in the hand-over) | 1.5 |
| **I6** | **The matte refined against the full-resolution picture** (§4.7 point 3): `key_refine` as the whole alpha path in the app-only `renderer/editor/keyworker.js` (from I4), `keymatte.js` pure beside it (the bilinear float upsample, the guided filter from `inpaint_depth.js:213` with `boxBlurs` from `px/kernels.js:370`, both imported, not changed; **the guide the chroma distance to the screen colour, or three channels, chosen by the edge measurement**), the band with a **halo ≥ 2r** read through `readBox`, unbanded under about 16 MP, the radius and eps from the upscale factor, wired into §4.5 step 2 before the mask is written; a 15k measurement (seconds per band and in all for 4k, 8k and 15k boxes at the working size; the edge against the unrefined run; the guide chosen and why) into `docs/measurements/ck_i6_<date>/`; only then the status sentence says "refined" | `host.js`, `renderer/editor/keyworker.js`, new `renderer/editor/keymatte.js` (both app-only, **no FILES change, no node build**), `tools/keymatte_test.js` | Normal (a mask path): `node tools/keymatte_test.js` (a synthetic soft matte against a sharp edge **of equal luminance, green against a skin tone**, snaps to within 1 px; a flat picture leaves the matte as it is; **no band seam**: a vertical edge crossing a band boundary stays straight within 1 level; the halo trimmed exactly); the `key` gate's refine step on both backends (a 15k box in bands), `pxjobs` untouched | hair edges on the scaled path judged by the user at Stop B against I0a's native reference of the same still; the 15k cost recorded | 1 |
| **I7** | **The command and the assistant** (§4.8): `key_screen` with `preview` and `rekey`, `status.key`, `RUNS` and the ask card, `docs/COMMANDS.md`, the count 117 in README and `docs/MCP.md`, the `.mcpb` | `renderer/commands.js`, `electron/main/assistant/policy.js`, `docs/COMMANDS.md`, `README.md`, `docs/MCP.md` | `commands` (a `key_screen` step on the stub, a `preview` step reading the selection's bytes, a `rekey` step), `mcp`, `mcpb`, `assistant`, `lint`, `types` | the gates green; README and MCP.md say 117 | 0.5 |
| **I8** | **Docs and the live run.** The manual chapter (§4.12), the README line, About, `docs/HELPERS.md`'s rows (pinned revisions, sha256, licences), the CHANGELOG, item 49's hand-over in CLAUDE.md, `THIRD_PARTY_NOTICES.md` where the set is hosted. **The live run** on the dev machine with the real engine (the user present; the user's ComfyUI idle or after Free VRAM): green and blue stills with and without a hint, Source = active layer on a generated subject, a 15k document with a 4k box and the whole picture (the refine), a Cancel mid-run, the set missing (the download block end to end from the test host), the process killed mid-run, the live loop by the user's hand; seconds, private bytes and VRAM into `docs/measurements/ck_i8_<date>/`; the first key judged by eye at 100 % against I0a's native reference of the same still (the trim, the despill default, the refined hair); the texts placed by the hosting case (§4.12) | `docs/MANUAL.md`, `README.md`, `CHANGELOG.md`, `shell.js` (About), `docs/HELPERS.md`, `CLAUDE.md` (item 49's block and the "Where things stand" line only), `THIRD_PARTY_NOTICES.md` | Light for the docs (`help` renders the manual); the live run is the feature's test | **Stop B:** the refined in-app matte good enough on the user's pictures, or B0-B5 (*Full resolution on your ComfyUI*) go in before the release; **the hosting answer in hand, or the user's decision** (Route B for 0.1.52, wait, or the in-app route dormant; §6); a defect found means a fix session before the release | 0.5 + the live run |
| **B0** (Route B) | **Route B's remaining probe** (what I0a did not take): a scratch raw-API script queues stills through the server: crops of the user's green plate at 1, 2, 4, 8 and 16 MP with and without a hint, a tight box against a loose one, the despill on blue by eye, what the pack evicts and the next Generate's reload, one run with `auto_download: true` on a fresh models folder observed on the websocket for `progress` frames and the interrupt flag after a Cancel; a real output cropped to about 512 px as the `key` gate's Route B fixture | `docs/measurements/ck_b0_<date>/summary.txt` | none (a measurement) | `KEY_CAP` from the numbers; the download switch allowed or not; `rgba` usable or the two-output fallback; blue despill | 0.5 + the user's time |
| **B1** | **`keying.js`'s pack side**: the pack table, `serverSupport`, `keyPrompt`, `trustOption(spec, trust)`, `hint(message)` for the pack's failures (missing models with the file list, "needs an NVIDIA GPU (CUDA)", CUDA OOM, the generic last line), its own `withSpecDefaults`; `settings.js` DEFAULTS.key gains `cap`, `keepOnGpu`, `evicts`, `comfyTimeout` | `keying.js`, `electron/main/settings.js`, `tools/keying_test.js` | Light: the graph for every input combination against the saved spec; the trust mapping; `lint`, `types` | the test green; the graph validates against `tools/refs/corridorkey/` | 0.75 |
| **B2** | **The ComfyUI run**: `host.keyComfy(editor, opts)`: the uploads, `comfyPictureRun(..., "ck_out", ...)`, the banded PNG decode, the scaled path, `landKey` shared with I4; the token and `providerPending` like `realismWhole` (`:3435-3442`) | `host.js`, `keying.js` | Normal: the `key` gate's Route B steps stubbing `host.comfyPictureRun` with B0's fixture (the bytes exactly, a refusal, a cancel, the scaled path within a level) on both backends | the gate green on both backends | 0.75 |
| **B3** | **The dialog's route row** *Full resolution on your ComfyUI* (the readiness line of §4.11, the keep-on-GPU tick, the ComfyUI timeout, the first-run block, the download switch only if B0 allowed it) | `renderer/dialogs.js`, `host.js`, `shell.js` | Normal: the `key` gate's route step, `skins`, `editor`; one look in the app | a key through ComfyUI end to end against the stub, and once against the user's ComfyUI on their word | 0.5 |
| **B4** | **`key_screen route: "comfyui"`**, `status.key.comfy`, the ask card's route line, `docs/COMMANDS.md` | `commands.js`, `policy.js`, `docs/COMMANDS.md` | `commands`, `mcp`, `mcpb`, `assistant` | the gates green | 0.25 |
| **B5** | **Route B's docs and live run**: the manual's Route B section, `docs/RECIPES.md`, `docs/HELPERS.md`'s "Models on your ComfyUI that Scumble drives"; the live run on the user's ComfyUI (the user present, `/queue` first): green and blue stills, a 15k document with a 4k box (native) and the whole picture (scaled + refined), a Cancel mid-run, the pack missing, the models missing; seconds and VRAM into `docs/measurements/ck_b5_<date>/` | `docs/MANUAL.md`, `docs/RECIPES.md`, `docs/HELPERS.md`, `CHANGELOG.md` | Light for the docs; the live run is the test | the route judged on the user's pictures; a defect means a fix session | 0.5 + the live run |
| | **Release block** (§4.10): the CHANGELOG section `## 0.1.52 - <date>` (the in-app route's line only with the set offered, else it stays under `## Unreleased`), `package.json`, the full gate list on both backends, `npm run dist`, `dist:portable`, `dist:store`, the exe gates once on tiles and canvas (`--exe`), the Store notes (`dist/store-listing/whats-new-0.1.52.txt` covering 0.1.48-0.1.52: the Store is at 0.1.47; nothing of a live matte without the set); **no node steps** (no shipped editor file changed; should a later decision put keying into the node, that update carries a clone, `build_node.py --check`, `node_test.py`, the node commit and push, and a Registry scan of the shipped files for tokens like `.listen(` first, K40's rule); the hosted set's upload and the registry URLs (the hosting answer in hand); **`corridorkey` merged into `main` (a fast-forward), main pushed, the tag `v0.1.52` on main**; the release chain on the user's word (`docs/RELEASING.md`: the CI draft, publish, the post, `server.json` and the MCP Registry, the Store upload); then `main` merged into `wasm-kernels`, the kernels' `## Unreleased` line placed above 0.1.52's section | | | | 0.5 |

**Totals (inferred):** Route A about 9.5-10.5 days (I0a-I8 and the release block; I1 at 1 day with MarcelineVPQ's
scripts, 2-3 without; I0c's 0.25-0.5 day only if Stop A's go is on another ORT version) plus the user's time at I0a,
I0b's preconditions and I8; Route B about 3.5-4.5 days more if built (B0-B5), or alone about 4.5-5.5 days on a no-go.

**Stops:** **A** after I0b (go / no-go, the provider, the ORT version, the working size as the live bucket, the loop's
end-to-end cadence; on a no-go B0-B5 are 0.1.52), **B** after I8 (the refined matte on the user's pictures; Route B's
phase 2 option; the hosting answer, or the user's decision without it; a defect). Not a stop: I5's mid-stroke Re-key
decision (measured by the user's hand, recorded in the hand-over).

## 6. The user's answers, and the questions still open

**The user's answers (2026-10-24; AskUserQuestion; binding):**

1. **Route order: in-app first** ("In-App zuerst"), chosen against the plan's recommendation of ComfyUI first. The spine
   is CK2 inside Scumble on onnxruntime-node in an Electron utility process, aiming for the live alpha hint Corridor
   describes. The standing rule holds: the spike (I0b) with its numeric go / no-go comes before any app code of the
   engine. Choosing in-app first counts as the yes to the spike's 2.4 GB test download (Nucito's fp16 set into a scratch
   folder).
2. **Branch and release:** a branch **`corridorkey` off `main`**, released as **0.1.52 on the user's word**, then `main`
   merged into `wasm-kernels`.
3. **Pack A on the production ComfyUI: yes, after a code check** (the whole pack read first, the findings to the user,
   then a pinned install; the 5.1 GB models; a restart only when the machine is free and on the user's word): I0a.
4. **Keying the base: a mid-grey Fill layer between the base and the key, in the same undo step** (question 10 of the
   first plan, option b): §4.5 step 5.

**The plan's other recommendations stand as taken:** the landing as a new layer with the matte as its layer mask and a
source layer hidden; the trim to the matte's box; the naming ("Key green / blue screen", the layer "Key", "CorridorKey
2.0" where the text is about running it); `keep_on_gpu` off where Route B is used; Corridor's remaining written
questions after the first measurements (Stop A); the Store 11.16 check at the next Store update.

**Question 8 (entries in shipped files) re-decided by the plan, with the code read again (§2.4, §4.6, §4.7):** the live
hint loop needs **no shipped-file change at all**: a stroke's dabs reach host.js through `host.pluginPointer`, which the
editor calls on every pointer move before any brush branch (`inpaint_canvas.js:6529`; host.js's own method,
`host.js:1210`), a stroke's end through `host.changed`, and the overlay draws in `host.pluginOverlay`; a mask stroke is
followed at its end (it lives in a `StrokeBuffer` until pointer-up). The refine was the one shipped-file change, and
there the choice is real, with costs on both sides: **(a)** a shipped pool op `key_refine` in `inpaint_worker.js` plus a
shipped `inpaint_keymatte.js`: the node gets the op for free, the release carries a node build (a clone, `build_node.py
--check`, `node_test.py`, the node push) and `inpaint_worker.js` must merge with the kernel branch, where the K-sessions
move it; **(b)** an app-only module worker `renderer/editor/keyworker.js` (the `stitch_worker.js` precedent): no node
build, no merge friction, and the node does not get the op. **(b) for 0.1.52** (decided here): the node's editor has no
key feature and the node runs inside a ComfyUI where pack A keys directly. **The user is asked only if keying is wanted
in the Inpaint Canvas node**; then the op moves to the shipped worker in that update, with the node build. The
layer-row / context-menu entries and `selectionOrigin` wait for a later update.

**A fact to confirm now (the user):** was the thank-you reply to Corridor sent, and which version? The chat's second
version asks 1-3 and 5 of §3.4 (the first version asked none of them); 4, 6 and 7 follow after Stop A, and whatever
the sent text left out joins them.

**Still open**, each with the recommended answer and the session it must be answered before; where nothing is said by
then, the recommendation is taken and the hand-over says so. Numbers the measurements produce (the provider, the
working size, the loop's cadence, the CPU cost, the ORT version) are not asked: Stops A and B answer them.
Licence-required texts (the seat sentence, the terms paragraph) are stated, not asked.

1. **Hosting (before the release; the registry URLs).** Once Corridor says yes in writing: a Hugging Face repo under
   your account whose name carries "CorridorKey" (the HF API gives the sha256 the registry checks; the token rule and
   the Store's privacy URL already cover the host), or GitHub release assets (2 GB per file, a second host for the
   downloader)? *Recommended: Hugging Face.* If Corridor publishes an official export, the registry points at it instead.
2. **Corridor's remaining written questions (after Stop A).** Send 4, 6 and 7 of §3.4 (and 5, unless it went), and 2
   again with the spike's numbers, in the same thread or by email? *Recommended: yes, after Stop A, so the message says
   what we measured.*
3. **No written hosting answer by Stop B (at Stop B; the user's time and their outward relation).** Build Route B
   (B0-B5, about four more days) for 0.1.52; wait for the answer before any release; or release 0.1.52 with the in-app
   route dormant (`keying.inAppOffered` false, §4.3) and nothing else of keying in it? *Recommended: Route B.*
4. **Store policy 11.16** (the live generative-AI disclosure, in force since 7.19): was it ticked in the 0.1.47
   submission? *Recommended: check in Partner Center at the next Store update; not CK-specific.*

**Decided here, not asked:** **the export is Scumble's own** (§4.3; Nucito's set is ruled out as what ships by its missing
`Notice`, its licence "other" and its age; the dev-side venv of about 3 GB in a scratch folder never reaches the app or
the repo, which CLAUDE.md's rule allows, and its disk use is said in one line in chat before I1 installs it, as a
download is: a disk ask, not a plan question); **the engine's residency: the 60 s idle kill** after the dialog closes
and the kill before every local ComfyUI run (`freeHelpers` handles the collision, the cost is a Stop A number, the
readiness line names it); **the refine in an app-only worker** (b, above); **the `key` record session-only** (§4.5 step
5: no `.scumble` field, Re-key falls back to the layer's bounds after a restart); **the working size is the live bucket**
(Stop A's largest bucket inside the end-to-end budget, 1,024 or 768; one resident bucket; a larger one for Apply only
on the setting); **the ORT pin exact** at I0c or at the latest I1 (the `^` goes either way); the refine against the
full-resolution picture as a core session (I6); the box and the features fixed when the dialog opens, *Refit the box*
for a change; the CPU offered with its measured cost when the fp16 set runs there at all, no second fp32 set in 0.1.52;
the hint trust defaults of §4.6; `hint_quality` −1 and a zero plane for no hint; despill 0.5 for both screens, the
channel swapped for blue (Route B's pack B: 0 for blue, green-only); Nucito's set a test set only; the export scripts out
of the repo until Corridor's answer 1, a separately licensed folder in the app no path (§3.1); `withSpecDefaults`
copied, not moved (Route B); `auto_download: false` always on Route B, its download switch only on B0's evidence; no
Comfy Cloud and no paid host.

## 7. Risks, and what changes the plan

- **The spike's odds.** DirectML in maintenance mode with the B5 memory blow-up and LaMa's failure; WebGPU in
  onnxruntime-node experimental and never run in Scumble; no CUDA on Windows; decomposed attention in Nucito's set
  (about 1 GB of transients at 1024², inferred). **Changes the plan** on a no-go at Stop A: Route B (B0-B5) is 0.1.52,
  the engine's sessions are not built, the numbers go to `docs/measurements/ck_i0b_<date>/` and the plan's status line
  says so. A go on WebGPU alone means the readiness line names WebGPU and the manual says "experimental provider".
- **Parity.** The reference is a bf16 autocast run on the user's card (I0a), the engine fp16 on another provider: two
  roundings, and fp16's range on top (upstream chose bf16 on MPS because scene-linear highlights overflowed fp16,
  `pipeline.md` §5; Scumble's 8-bit sRGB input bounds the input code, the stage-2 activations and the fg logits on
  speculars are where it would first break: the blown-highlight still of I0a checks NaN / Inf and the fg error there).
  The thresholds of §4.2 allow for the roundings; what they cannot catch, the user's eye on hair at 100 % does (Stop A
  and I8). **A failure is located, not guessed:** the per-graph rows (features, baton, logits) and the identical input
  PNG name the graph and its pre-processing; a pre-processing mismatch is a harness fix, not a no-go. A parity failure
  at one bucket drops that bucket, not the route.
- **The export.** MarcelineVPQ's five patches (shifted windows, 4D attention, the C-RADIO position grid on portrait
  inputs, MoGe's position encoding, `value_info` dropped) are known; new ones may appear at 1536 / 2048; C-RADIO may
  have to stay fp32 (+0.86 GB). The scripts' licence may be non-permissive (own scripts then, two to three days). **The
  middle rung** (§4.3) is what keeps this from changing the plan: a decomposed own export at ≤ 1024 ships with the
  notices when MHA cannot be emitted or fails on the provider, and 1536 / 2048 wait. **Changes the plan** only if neither
  rung passes parity or the memory list on the provider where Nucito's set did: Stop A is re-opened with the numbers,
  and the hosting question becomes Nucito's set re-hosted with the missing notices, asked of Corridor and of Nucito.
- **Hosting without Corridor's written yes.** Nothing is hosted; what 0.1.52 ships is the user's decision at Stop B
  (§6: Route B, wait, or the in-app route dormant behind `keying.inAppOffered`); the in-app route waits (§4.3). A
  Discord "yes" is not enough for hosting converted weights (§2(a) "redistribute ... in whole or in part").
- **The live loop's cadence.** Stop A's end-to-end figure sets what "live" means: ≤ 150 ms follows the brush dab by dab,
  ≤ 250 ms follows each stroke's end, above that the loop is honest seconds per stroke and the dialog says so. The dabs
  come through `host.pluginPointer` (no poll, no hook, no node build, §4.6); the requests are coalesced so a fast painter
  never queues runs behind one another; the window's round trip is measured at I5, not assumed. Stage 1's `alpha_aux` at
  /2 is the cheaper mid-stroke preview if stage 2 is the cost (measured first).
- **The ORT version.** A go only on 1.30.0, or on its WebGPU provider, moves the dependency for every helper and the
  packaged exe; I0c pins it exactly and re-runs the helper gates before I1 (§5). The `^` pin is replaced either way.
- **The refine's limits.** A guided filter sharpens a soft matte along the picture's edges; it cannot invent hair the
  working size lost. **Changes the plan** if Stop B finds hair too soft on the user's 15k pictures: Route B's *Full
  resolution on your ComfyUI* (B0-B5) goes in before the release, or a larger bucket where I1 proved one.
- **The GPU shared with the user's ComfyUI.** 2.4 GB of weights beside Flux on one card: the 125 s paging precedent
  (`HELPERS.md:370-374`). `freeHelpers` kills the engine before a local run; the dialog's readiness line says "Free
  VRAM first" when the last key was slow (`slowHelperHint`'s rule). The 60 s idle kill (decided, §6) keeps the card
  free between dialogs.
- **Other cards.** Wrong attention logits on RDNA2 under DirectML and wrong predictions on Intel integrated GPUs under
  WebGPU in Electron are reported upstream (§2.3). The readiness line says "tested on NVIDIA RTX cards"; a report from
  a user with another card is read before anything is promised. The CPU path's cost is stated, not hidden.
- **The utility process dying mid-run** (a device removed, an out-of-memory in the provider): one red status sentence,
  nothing landed, the overlay dropped, the process restarted on the next request; `kill()`'s memory return is a go
  criterion so a loop of crashes cannot fill the machine.
- **The 2.4 GB download.** sha256 per file, resume, the overall bar and the free-disk check (I2) are built before the
  set is offered; a changed file on the host fails the hash and says so. The HF token rule closes a leak that is not live
  today (every registry URL is huggingface.co; an entry on another host would send the token there, `models.js:298-299`):
  the `docs/BUGS.md` line goes in with this plan's commit (BUGS.md had none at the time of writing), I2 closes it.
- **Compositing in gamma space; 8-bit clip.** A matte made for linear-light "over" can show a faint halo on hair against
  a bright background. Known limitation, in the manual; a linear "over" for masked layers is a compositor change (Full
  tier, another update). If the user's pictures show it badly, the layer's Match slider and the mask are the tools.
- **The grey Fill layer.** A procedural filter layer covering the document: it hides everything under the key, including
  layers the person may have wanted to keep visible under a keyed base; the Source row's *Leave the base as it is*
  covers that case, and the status names the grey layer.
- **The shared file with the kernel branch.** `host.js` moves on both branches (`keyScreen` one method beside
  `realismWhole`, K0a's marks in `saveExport`); `inpaint_worker.js` is not touched here (the refine's worker is
  app-only); CLAUDE.md's hand-overs on the branch stay inside item 49's block and the "Where things stand" line. The
  merge after 0.1.52 is read by hand.
- **Time.** Route A is about twice Route B's effort before anything ships; the user chose it knowing the spike comes
  first. A no-go at Stop A costs one and a half days and leaves the spike's harness and numbers.
- **Licence.** The weights are a user download under Corridor's licence; the glue is Scumble's own code written from the
  README (L509-541) and a textbook despill; the export scripts stay out of the repo until answer 1 and never enter it on
  a "no" (a separate repository under Corridor's licence then, §3.1); no CK-licensed folder in the app, whatever the
  answer (CLAUDE.md's licence decision stands); a hosted set carries every notice (§3.3). Should Corridor answer
  differently in writing than on Discord, the exposure is the texts and the feature's presence, and the user decides.
  The free Store copy stays free.
- **Production machine.** I0a, B0 and B5 only with the user present, `/queue` checked, no restart of their ComfyUI by
  Claude; the gates run `--offline` with the engine and the host stubbed; the engine's real runs on the dev machine with
  the user's ComfyUI idle or after Free VRAM.
- **What would make this plan drop Route B entirely:** Corridor publishing an official ONNX export with hint-only re-runs
  *and* I1 measuring a stable GPU provider at 2048 with the memory given back: then the refined in-app final is close to
  native for most of the user's boxes and Route B stays documentation. Nothing read today points that way.
- **Unverified until the sessions run:** every timing on the user's card; DirectML and WebGPU device creation inside a
  utility process; Nucito's bucket list, input dtypes and pre-processing (read at I0b's first step); the GPU performance
  counters reporting a utility process's dedicated usage (they report per pid; a child of Electron is a pid like any);
  the own export's parity and memory at every bucket; the hint polarity in the ONNX graphs; the effect of a key on the
  user's Flux runs; the dab-by-dab follow's feel end to end; the chroma guide against the three-channel one.

## 8. Sources (read 2026-10-24)

- The five research reports, committed under `docs/research/ck2_2026-10-24/`: `pipeline.md`, `licences.md`,
  `onnx.md`, `comfyui.md`, `app.md` (each with its fact list and sources; the section references in this plan, such as
  "`pipeline.md` §4", point there). Not committed (third-party code, the planning session's scratchpad only): the clones
  `ck_comfy/` (the two CK2 packs, upstream `485f5e9`, ComfyUI v0.42.4 core files, the Inpaint Canvas node's `nodes.py`
  at `4e7bd24`), `ck_pipeline/`, `ck_licences/` (the licence texts, NVIDIA's OML extracted).
- The user's answers of 2026-10-24 (AskUserQuestion in the planning session; §0, §6).
- nikopueringer/CorridorKey2.0 @ `485f5e9` (code), `nikopueringer/CorridorKey2.0` @ `cf44a8d` (weights, LICENSE);
  marawan206/ComfyUI-CorridorKey2.0 @ `eeee7fa`; hashu786/ComfyUI-CorridorKey2 @ `141c31b`; Nucito/corridorkey-web
  @ `1ae72ca`; MarcelineVPQ/corridorkey-desktop @ `372f042` (docs only); peterteravskis/corridorkey-v2-mlx
  (benchmarks); corridorkey.com (the seat prices); the Microsoft Store Policies 7.20; onnxruntime v1.29.0's DirectML
  operator registration and WebGPU `multihead_attention.cc` (`onnx.md` §5).
- Scumble at `ec1142b`: the anchors named above; `docs/PLAN_0_1_42.md` (the Realism Pass as the model for a helper
  route on the user's ComfyUI), `docs/PLAN_RELIGHT_BUILD.md` and `docs/PLAN_WASM_BUILD.md` (the rules and the shape),
  `docs/HELPERS.md` (LaMa's process, B5, the paging precedent), `docs/BUGS.md:110-119` (B5), `docs/RELEASING.md` (the
  chain assumes main).
- Measured on this machine during the second critique (2026-10-24): `nvidia-smi --query-compute-apps=pid,used_memory`
  answers `[N/A]` per process under WDDM, `memory.used 8115 MiB` of 32,607 with ComfyUI idle; the production
  `python_embeded`'s `pip list` against pack A's `requirements.txt` (every pin satisfied, four opencv builds side by
  side); `git log --oneline main..wasm-kernels` = 16, `wasm-kernels..main` = 0. Windows' GPU performance counters (`GPU
  Process Memory`, `GPU Adapter Memory`) are the per-process VRAM source.
