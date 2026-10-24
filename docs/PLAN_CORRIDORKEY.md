# CorridorKey 2.0 in Scumble: the build plan (item 49)

**Status: planned 2026-10-24 against `ec1142b` (branch `wasm-kernels`; `main` = 0.1.51 at `2d9a353`). Nothing built.**
This file turns the research of 2026-10-24 (five read-only readers: CK2's pipeline from source, the licences, the
in-app ONNX feasibility, the ComfyUI packs, Scumble's own anchors), three designs (ComfyUI first, in-app first, the
user's flow) and two critiques of them (feasibility; the user's rules) into sessions. Every defect the critics found is
folded in; where they disagreed, the choice is stated in one line. Every effort figure is **inferred, not measured**.
Every line number is from `ec1142b`; grep the name before editing. Facts are **read** unless marked **inferred** or
**unverified**. This plan may name other products and packs (the rule of 2026-09-29 covers CLAUDE.md, the posts, the
CHANGELOG, the manual and the README); the app's texts say "CorridorKey 2.0" only where they are about running it.

## 0. The record

**The user (2026-10-24):** "wir haben das ok von corridor crew, können es integrieren ^^ aber dann v2 ^^". Before that
(item 49, CLAUDE.md): "können wir das auch für images nehmen?", "evtl im nächsten update", and on v2 on stills: "das
müssten wir prüfen".

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
GPL-3.0 while the weights stay under their licence; whether a converted copy of the weights (ONNX, fp16) may be hosted
if the in-app route ever needs one; how they want to be credited; the US $20M seat clause as it reaches Scumble's
users; what "the alpha hint works in real time" refers to (no public CK2 code has a live hint; §2). The thank-you reply
drafted for the user on 2026-10-24 already asks 1-3 and 5 in short form (GPL-3.0 for our glue, hosting an ONNX
conversion or an official export, the credit, what the real-time hint runs in); if the user sent it, only 4, 6 and 7
are left for after C0. **Phase 1 of this
plan depends on none of these answers:** it ships no CorridorKey code and hosts nothing, so the release does not wait
on Corridor. Phase 2 (in-app) waits for answers 1 and 2.

## 1. What the user gets, and how pixels land

**The behaviour in one sentence (the say-behaviour-first rule; repeated in chat before C2):** *Key green / blue screen*
adds one new layer directly above the layer or picture you key: its pixels are the subject's own colour with the green
or blue spill taken out, its layer mask is the matte CorridorKey 2.0 pulled on your own ComfyUI, the layer is trimmed
to the matte's box; when the source is a layer, that layer is hidden in the same step, when it is the base picture it
stays as it is under the key (with a mid-grey layer between them by default, question 10); nothing else changes, and one Ctrl+Z takes it all back.

What a person does and sees:

1. Opens a green-screen photo (the base), or has a *Generate* result of a subject on flat green as a layer. Optionally
   selects the subject roughly: the selection brush, the quick mask (Q), a wand click, a SAM click, *Select by text*.
   No selection is fine: the model picks the subject itself.
2. *Image › Key Green / Blue Screen...*. A small dialog: **Screen** Auto / Green / Blue; **Hint** From the selection
   with its trust (Rough 0.5 / Automatic 0.75 / Clean 0.95) or None; **Despill** 0.5; **Source** the visible picture or
   the active layer; a line saying what goes ("the selection's box, 3,210 × 4,100, at its own size", or "scaled to
   4,899 × 3,266 for the model; the matte comes back at full size"); the readiness line (what the connected ComfyUI
   lacks, if anything); *Key*.
3. The status row's bar follows the run on the user's ComfyUI. A warm key of a 1-4K box takes about 1-3 s on an RTX
   5090 (inferred from pack A's 4090 clip numbers, §2), plus about 10 s once for the model's load.
4. A new layer **Key** lands above the source with a layer mask. The screen is gone; hair and motion blur keep their
   soft edges; the colour is unmixed, so there is no green fringe. Status: "Key: 38 % of the box kept, in 2.4 s on
   your ComfyUI (CorridorKey 2.0, green screen, hint from the selection)."
5. Fixing edges: the mask is an ordinary layer mask (*Show alone*, P / E, `set_mask`). *Re-key with this mask* (C6)
   sends the painted mask back as a clean hint, so the model redoes hair and blur from the correction; seconds per
   round, not real time (§4.4 says why).
6. A background under it (a Paint layer, a *Generate new* result, a loaded image placed under the key layer); colour
   match with source "underneath" if wanted; PNG with alpha, PSD or ORA with the mask intact.
7. Agents: `key_screen` (C4), in the assistant's RUNS set (it asks first).

**The first time:** the dialog says the models are missing on the ComfyUI machine (about 5.1 GB), names the four
components with their licences and the one clause users must know (organisations above US $20M revenue need a
CorridorKey seat per user), and says how to fetch them (§4.6). Nothing of it is in Scumble's installer, MSIX or zip.

**A 15k document:** the key never sends 150 MP. It sends the selection's box with context (or the whole picture when
nothing is selected), at its own size up to a measured cap, scaled above it; the answer is decoded in bands and the
layer is the matte's box, so a 4k subject on a 15k photo costs a 4k layer, not a 600 MB one. No document-sized canvas
is made anywhere (the 268 MP limit, `renderer/editor/inpaint_pixels.js:71-80`).

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
  GUI PRs shell out to `infer.py`; what Neex's "real time" refers to is unverified (asked, §3.4).
- **Colour.** Input display sRGB in [0,1] (PNG / JPG read by OpenCV and divided by 255, so 8-bit) is converted to
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
  at 24 MP, a minute or two at 150 MP. "Real time" holds at video sizes, not at 15k.
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
trip, the queue and the model's move to the GPU. **Neither pack caches the feature models across runs**, and
ComfyUI's cache hits only on identical inputs: every hint change re-runs everything.

Upstream's `estimate_peak_vram_gb` counts a still as **8 frames in normal mode** (`runtime.py:160-170`, `frames =
max(frames, chunks[0])`), 13.9 GB at 8.36 MP extrapolated; pack A's `select_profile` then falls to low-VRAM mode, which
is slower. So a cap of 16 MP sits inside normal mode on a 32 GB card only if the budget allows it; **C0 measures the
mode the Advanced node's `info` string reports.**

### 2.3 The in-app ONNX route (why it is phase 2)

- onnxruntime-node 1.29.0 on Windows ships CPU, DirectML and an **experimental** WebGPU provider; **no CUDA, no
  TensorRT on Windows** (`node_modules/onnxruntime-node/README.md`; `electron/main/onnx/runtime.js:19-26` never tries
  `webgpu`). Session creation and `run` are synchronous native calls: every helper but LaMa blocks main's thread.
- **DirectML** is in maintenance mode, its core kernels stop at opset 21, LaMa fails on it (`docs/HELPERS.md:285-291`),
  and one 1024² BiRefNet-lite run took main's private bytes from 1.3 to **24.7 GB** (B5, `docs/BUGS.md:110-119`). An
  open issue shows its attention kernels wrong on RDNA2.
- **No official ONNX.** Nucito/corridorkey-web (fp16, opset 17, default domain only, attention decomposed, 18 static
  buckets up to **1024²**, 2.43 GB, one day old, ships C-RADIO without NVIDIA's `Notice` file);
  MarcelineVPQ/corridorkey-desktop (dynamic shapes, opset 23 + `com.microsoft::MultiHeadAttention`, needs ORT ≥ 1.31,
  files unpublished, five patches to export, checked on CPU and CUDA only).
- **Quadratic attention:** without a fused kernel the stage-2 score tensor is about 0.54 GB at 1024² and **8.6 GB at
  2048²** (inferred). Native 4K or 15k in-app is out; a working size is a product decision.
- Verdict of the reader: plausible at about 1 MP in a utility process, risky beyond, **measure first**.

### 2.4 Scumble's side (read at `ec1142b`)

- **No existing route carries colour and alpha into one layer.** An edit recipe loses the alpha (the node's stitch keeps
  RGB and writes the layer's alpha from the feathered selection, ComfyUI-InpaintCanvas `nodes.py:873-874, 921`); the
  whole-picture route refuses any graph that reads the mask (`renderer/editor/comfyprompt.js:57-71`) and replaces the
  base; the cutout route lands only a mask over the layer's old pixels (`renderer/editor/inpaint_canvas.js:16386-16419`),
  so the green edges stay, and it passes no hint. A **helper prompt of Scumble's own** in the shape of
  `realism.passPrompt` (`renderer/editor/realism.js:469-482`: LoadRef → pack nodes → `PreviewImage`), run through
  `host.comfyPictureRun` (`renderer/editor/host.js:3025-3137`: queue, wait, cancel, timeout, `/history`, the bar) and
  landed with `addLayer` (`inpaint_canvas.js:18657-18689`) does it with no node change.
- **`InpaintCanvasLoadRef` loads RGB only** (`nodes.py:949-975`); a hint goes as a grey PNG through core `ImageToMask`
  channel red (ComfyUI v0.42.4 `comfy_extras/nodes_mask.py:149`): white = 1 = subject. `JoinImageWithAlpha` inverts
  its mask and is not used. ComfyUI's `PreviewImage` writes a 4-channel IMAGE as an **8-bit straight RGBA PNG**
  (`nodes.py:1708, 1730`).
- **Layers are 8-bit straight RGBA8 tiles**; bytes entering without a canvas pass the measured premultiply round trip
  (`inpaint_tiles.js:3-5, 27-30, 537-553`), so a straight colour at alpha *a* survives with about *a*+1 levels
  (inferred). The compositor blends gamma-encoded bytes with premultiplied 8-bit integer maths and no linear conversion
  (`crates/px/src/composite.rs:1-21`). There is no 16-bit layer path. **`Layer.fromImage` draws through a 2D canvas and
  premultiplies** (`inpaint_tiles.js:797-804`): a straight RGBA PNG must be decoded by Scumble's own reader.
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
- **`withSpecDefaults` is private to `inpaint_canvas.js:1046-1064`** and calls `host.nodeTypes()`; `comfyprompt.js` is
  app-only and pure ("not in tools/build_node.py FILES", `comfyprompt.js:10-11`). `tools/build_node.py` FILES (`:36-49`)
  lists the editor modules the node ships; `realism.js`, `comfyprompt.js`, `host.js`, `stitch.js` are app-only; every
  `host.<member>` a shipped file uses must exist in the node's own `js/host.js` too (`check_host`, `:163`; the flags
  `removeSupported` / `depthSupported`, node `js/host.js:165, 178`).
- **Reads at model size without a full flatten:** `pictureInputBox(editor, box, w, h)` (`host.js:5235-5261`, tiles
  through `sampleRegionSettled`, canvases through `flattenToCanvas`, which documents under 268 MP allow),
  `cutoutInput` (`:4945-4967`, a layer's own pixels from its levels), `objectInput` (`:4899-4940`, a layer with its mask
  under a transform), `selectionCanvasSettled(box, scale, w, h)` (`inpaint_canvas.js:9209-9225`, the mask's mip levels;
  null on canvases, where the depth edit's `sel.drawTo` crop is the fallback, `:13666-13680`). **`maskToCanvas`
  (`:22689-22701`) reads the whole selection at document size and is not used.**
- **Readiness and refusals to reuse:** `realism.serverSupport({ state, os, gpus, objectInfo })` and `gpuGeneration`
  (`realism.js:74-128`), `realismWholeCheck` (`host.js:3386-3401`), `resizingRun` (`inpaint_canvas.js:12489`),
  `RUN_GOING_TEXT` (`:92`), `slowHelperHint` (`host.js:5344`). The run holds the document like a provider run
  (`editor.providerPending`, `_providerRuns`, the title row's Cancel, `host.js:3435-3442`); closing the tab ends it.
- **Undo:** `pushUndo({ kind: "layers", label })` then `addLayer` is one step (`host.js:3551-3557`); `snapshotLayer` is
  `{ ...l }` (`inpaint_canvas.js:14092`), so a `visible` change in the same step is restored with it; the mask-replace
  step kind is `layerfull` (`:3024`, `:5154`). **The base cannot be hidden** (no such field); only layers have `visible`.
- **Agents:** `cutout_layer` (`renderer/commands.js:1999-2016`) and `realism_pass` (`:1479-1502`) are the command shapes;
  the policy's `RUNS` set (`electron/main/assistant/policy.js:21`); `select_mask` thresholds to 0 / 1 (`commands.js:1031-
  1040`), so an agent's hint through the selection is binary. The tool count 116 is in `README.md:83, 303` and
  `docs/MCP.md:306`; `tools/mcpb_build.js:39` reads `docs/COMMANDS.md`.
- **Limits:** canvases 65,535 px a side and 268 MP; an IPC message of 600-800 MB ended the renderer, 500 MB passed (G2);
  the answer here comes over the proxied `/view` fetch, not IPC.
- **The downloader** (`electron/main/onnx/models.js:292-331`) checks size only, sends the HF token as Bearer to **every**
  URL (`:298-299`), shows one file's progress, and `findFile` looks each name up across flat `SUBDIRS` (`:78-95`).
  Phase 1 touches none of it; phase 2 fixes all of it (§4.9).

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

**Consequences for Scumble:** nothing of it in the installer, MSIX, zip or asar (the MIT / Apache / BSD / OFL rule);
**no route through fal, Replicate, Comfy Cloud or any paid host, ever** (§2(b); Comfy Cloud has no node anyway); the
seat clause binds Scumble's *users* and Scumble cannot waive it, so the first-run dialog and the manual state it; a sale
of Scumble means asking Corridor first. **Phase 1 is GPL-clean:** a ComfyUI graph is data, the pack's code and the
weights live on the user's ComfyUI machine, Scumble's own code (the graph builder, the landing) is Scumble's. Phase 2
would carry pre- and post-processing written from the README's documented input convention as Scumble's own code, or
in a separately licensed folder until Corridor's answer (GPL §10 "no further restrictions" against CK2 §5; a §7
additional permission is possible, DenRakEiw being the sole author of all 899 commits).

### 3.2 The components the pack downloads onto the ComfyUI machine

| Component | Publisher, pinned source | Licence | Size |
|---|---|---|---|
| CorridorKey 2.0 (`corridorkey_v2.safetensors`, `foundation_stats.safetensors`) | `nikopueringer/CorridorKey2.0` @ `cf44a8d` | Corridor Key Licence 2.0 | 2.66 GB |
| C-RADIOv4-SO400M (`model.safetensors`) | `nvidia/C-RADIOv4-SO400M` @ `c0457f5` | NVIDIA Open Model License (commercial use; a redistributor ships the agreement plus a `Notice` file; NVIDIA named for origin only) | 1.72 GB |
| MoGe-2 ViT-B normal (`model.pt`, the encoder is used) | `Ruicheng/moge-2-vitb-normal` @ `ca5f0e0` | MIT (DINOv2 code inside Apache-2.0) | 419 MB |
| RVM small, Recurrent Video MAE (`pretrain_rvm_small16_256_204031069.npz`) | `storage.googleapis.com/representations4d/...` (md5 pinned) | weights CC BY 4.0, code Apache-2.0 | 270 MB |

(`scripts/download_weights.py:77-88`, `THIRD_PARTY_NOTICES.md`; the HF API and a HEAD request; read.) Pack A's loader
fetches them into `models/corridorkey2/` (`corridorkey_v2.safetensors` + `foundations/{cradio,moge,rvm}`), resumable.

### 3.3 Where the notices show (phase 1)

- **The first-run block in the Key dialog** (shown while the models are missing, §4.6), one paragraph: *CorridorKey 2.0
  by Corridor Digital, Corridor Key Licence 2.0 (CC BY-NC-SA 4.0 with their terms), used with their permission in this
  free app; it loads C-RADIOv4 (NVIDIA Open Model License), MoGe-2 (MIT) and RVM (Google DeepMind, CC BY 4.0), about
  5.1 GB, which the node pack downloads from their publishers onto your ComfyUI. Your keyed pictures are yours, also
  commercially. Organisations with more than US $20M yearly revenue need one CorridorKey seat per user
  (corridorkey.com).* With links to the licence and corridorkey.com.
- **About** (`renderer/shell.js:2460`): "Green and blue screen keying by CorridorKey 2.0 from Corridor Digital (Corridor
  Key Licence, a CC BY-NC-SA 4.0 variant), used with permission in this free app; it builds on C-RADIOv4 (NVIDIA),
  MoGe-2 (Microsoft) and RVM (Google DeepMind), downloaded by your ComfyUI from their publishers." No logos.
- **The manual chapter** (§4.10): the hardware need, the pack's install steps dated to its commit, the four licences,
  the seat clause, the gamma-compositing and 8-bit notes. **`docs/RECIPES.md`:** the pack, its commit, the graph, as
  the Realism Pass's pack is named (`docs/RECIPES.md:259`). **`docs/HELPERS.md`:** a section "Models on your ComfyUI
  that Scumble drives" with the table above. **`docs/CODE_SIGNING_POLICY.md:101`** (the Store's privacy URL) needs no
  new host: Scumble itself downloads nothing for this feature; the manual says the ComfyUI machine fetches from Hugging
  Face and Google Cloud Storage. **The Store listing's description** names keying when 0.1.52's notes go up; the
  11.16 generative-AI disclosure is a general Store question (§6 Q11), not CK's.
- **Naming in the UI** (CLAUDE.md's rule): the feature is "Key green / blue screen", the layer "Key"; "CorridorKey 2.0"
  appears where the text is about running it (the dialog's title line and licence paragraph, the status sentence,
  About, the manual), which the rule allows for a model and the licence's §4 wants.
- A `THIRD_PARTY_NOTICES.md` in the repo comes only with phase 2, if Scumble ever hosts a converted set (then with
  Corridor's LICENSE, NVIDIA's agreement and `Notice`, Microsoft's MIT notice, the Apache-2.0 notice, the CC BY line).

### 3.4 Questions for Corridor (in writing; 1-3 and 5 in short form in the thank-you reply of 2026-10-24 if the user sent it, the rest after C0)

1. Scumble is GPL-3.0. Our ComfyUI route holds no CorridorKey code (a graph is data). For a later in-app route: may
   our own glue (ONNX export scripts, pre- and post-processing ported to JS) be released under GPL-3.0 while the
   CorridorKey weights stay under your licence, downloaded by the user from your Hugging Face repo?
2. If an ONNX / fp16 conversion of the weights is needed in-app, may Scumble host it under your licence and name with
   every third-party notice (NVIDIA's `Notice`, DeepMind's CC BY attribution, Microsoft's MIT), or would you rather
   publish an official export we can point at?
3. How do you want to be credited in the app (wording, a link to corridorkey.com; no logo, since CC licenses no
   trademarks)?
4. We will tell users that organisations above US $20M revenue need one seat per user. Is this wording right:
   "Organisations with more than US $20M yearly revenue need one CorridorKey seat per user (corridorkey.com)"?
5. "The alpha hint works in real time": does that refer to your plugin keeping the feature models' output between hint
   edits (a hint-only re-run of stage 1 + 2), and is any of that path public? Through a ComfyUI pack every hint change
   re-runs everything, so we see seconds, not real time.
6. Stills above 4K: is CK2.0 validated there, and above about 8192 px a side where C-RADIO's input leaves its tested
   256-2048 range? We plan: native up to a cap, scaled down above it with the matte brought back up against the
   picture. Would you cap, downscale and refine, or tile?
7. Blue screens: is the foreground already unmixed for blue spill, and does the green-limit despill need its blue
   counterpart on stills (the ComfyUI pack we use swaps the channel)?

## 4. The design

### 4.1 Routes

**Route 1, the whole of phase 1: the user's own ComfyUI with a CK2 node pack.** The only runtime Corridor validates
(CUDA bf16; §2.1), the card and ComfyUI the user already has, native resolution with fused attention, and the pack does
the 5 GB download and the VRAM dance. Scumble's rules hold: no Python or Torch bundled; no ComfyUI install path assumed
(everything through the URL, `/object_info` and the prompt, item 35 §2.5); Scumble keeps working without any ComfyUI
(the entry stays, the dialog says what is missing); the production machine is touched only on the user's word.

**Not a route:** Comfy Cloud (no node; §2(b)), fal / Replicate / any paid host (§2(b)), v1 (§2.1).

**Route 2, phase 2, only after a measured spike and Corridor's written answers 1-2:** CK2 in-app on onnxruntime-node
in an Electron utility process at a working size of about 1 MP, for a fast hint preview while painting, never the final
key at 15k. Its spec is §4.9; its sessions are sketched, not scheduled.

**Where the critics disagreed and what this plan does:** the "in-app first" design scheduled eight sessions on a
mechanism with a documented prior of failure (B5, LaMa on DML, no export above 1024); the two critics ranked it last
and this plan takes ComfyUI first. Its landing details (bands with `"add"`, no document-sized canvas), its hint-quality
table and its registry hardening are kept for the sessions that need them.

### 4.2 The pack table and the graph

`renderer/editor/keying.js` (new, **app-only**: not in `tools/build_node.py` FILES, like `realism.js`; pure, tested
under Node) holds a table of the two packs in the shape of `CUTOUT_BACKENDS` (`inpaint_canvas.js:1257-1310`): per pack
`id`, `label`, `needs` (the node classes `/object_info` must list: A `CorridorKey2ModelLoader` + `CorridorKey2Basic`, B
`CorridorKey2`), `build(refs, values)` → the graph, `output` (A `["ck_key", 2]`, B `["ck_key", 4]`), the input names of
hint / quality / despill / screen / download, `despillBlue` (A true, B false), `evicts` (A "the auto window may unload
other models", B "`unload_other_models` on by default"), `downloadSwitch` (A `auto_download`, B none). The pack present
is the one whose classes the server lists; neither class name clashes (the `CorridorKeyKeyer` clash is between two v1
packs); `python_module` (ComfyUI `server.py:855`) is checked only if a clash appears. **Pack A is the primary and the
one run live first** (a separate loader with `auto_download: false`, `keep_on_gpu`, a `screen` input that its despill
reads, an `rgba` output); pack B's entry is written from its README and marked unverified until a live run (Light
tier, as providers built from docs).

**The graph for pack A** (six nodes; `keyPrompt(pack, refs, values)`):

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

`hint_quality` is a combo on pack A: the module picks the option whose text carries the number ("0.95", "0.75",
"0.5") from the saved spec, else the spec's default. A copy of `withSpecDefaults` (20 lines on `host.nodeTypes()`,
with a comment naming the shipped twin in `inpaint_canvas.js:1046`) fills any required input a pack adds later, as it
did for SAM3 (issue #7). **`withSpecDefaults` is not moved**: both the "comfy" and the "user" designs proposed moving
it into `comfyprompt.js`, which is app-only, so the node's editor build would import a module the node does not have;
the critics' must. Pack B's graph: `CorridorKey2 { image, mask?, hint_quality: <float>, despill_strength, window:
"1/1", unload_other_models: <evicts setting> }`, `ck_out` on slot 4.

`PreviewImage` writes a temp file, so nothing lands in the user's output folder (the Realism Pass's reason too).

### 4.3 The landing

What arrives: one **8-bit straight RGBA PNG** (§2.2 "Output bytes", §2.4): gamma-encoded, clamped, despilled, exactly
the layer format. Highlights above 1.0 are clipped at the PNG; negatives went to 0 before; for 8-bit layers that is the
right loss and it matches every other layer. No colour conversion in the app.

**A new layer with opaque foreground pixels, the matte as its layer mask** (the critics' and all three designs' pick):
full 8-bit colour (opaque bytes pass the round trip unchanged), the matte editable with P / E and inspectable with
*Show alone*, the cutout's "the matte becomes the mask" habit, the memory of the matte's box, not the document's. A
straight RGBA layer would quantise exactly the hair pixels the keyer is for; a mask on the source layer would keep the
green fringe.

The steps, in `host.keyScreen` (C2):

1. **Decode straight, in bands, without a canvas:** `readPng(blob, { onRows, rowsPerBand: 256 })` in the window
   (`inpaint_png.js:201`), or the pool's `png_read` as the file open uses it (`inpaint_canvas.js:683`); C2 picks by a
   measurement at the cap. The bands are kept (at most 64 MB at the 16 MP cap) while the alpha's bounding box is taken.
2. **Trim to the matte:** the layer is created at the alpha's bounding box plus a 2 px margin inside the sent box
   (`addLayer` takes `x, y, w, h`; `objectInput` already reads layers smaller than the document). Pixels outside the
   matte are the model's noise under a zero mask; dropping them saves memory and makes the layer behave like a cut-out
   when moved. (Question 4.)
3. **Write the pixels:** `Layer.empty(w, h)` (`inpaint_tiles.js:785`), then per band an `ImageData` of the band's RGB
   with A = 255 through `writeRect(img, 0, y)` (`:1406-1413`, the copy path); on the canvas backend the same writes into
   a canvas of the box's size.
4. **Write the mask:** a fresh `Mask` of the layer's own pixel size (as the PSD import lands a layer with its mask,
   `inpaint_canvas.js:16881`; C2 confirms the mask's coordinate space in `drawPixelsInto`), filled per band with
   `combine(bytesSource(alpha, 0, y, w, bh), "add")` (`inpaint_raster.js:396`): **never `"replace"` per band**, which
   clears the bands before it (§2.4; the logit path's pattern, `inpaint_canvas.js:7934`).
5. **Land:** `pushUndo({ kind: "layers", label: "Key screen" })`, then `addLayer({ name: "Key", kind: "image", ref:
   null, dirty: true, px, maskPx, maskDirty: true, x, y, w, h, match: { strength: 0, source: "underneath" }, key: {
   box, scale, screen, despill, trust, source, pack } })`, moved to directly above the source layer (its index + 1) with
   `moveLayer(id, delta, { undo: false })` (`:18760`), or above the base when the base was the source; `ref: null` and
   both dirty flags, so `syncLayers` uploads the pixels and the mask (§2.4: without them a restart loses the matte);
   the `key` record is what *Re-key* (C6) reads. When the source was a layer, `visible = false` on it in the same step
   (`snapshotLayer` carries `visible`). The base cannot be hidden: it stays, and a mid-grey Fill layer between it and the
   key joins the same step by default (question 10), else nothing would look changed.
6. **Status:** "Key: N % of the box kept, in S s on your ComfyUI (CorridorKey 2.0, <screen> screen, <hint>)" plus
   "scaled down to W × H first" on the scaled path, `slowHelperHint`'s advice where it applies, and the log line.
   Cancel from the title row, a closed tab and a lost connection add nothing (`comfyPictureRun`'s kinds).

**The source pixels.** *Visible picture* (default): the composite inside the box through `pictureInputBox`
(`host.js:5235-5261`, filters skipped, `forRun: true`), the photo-as-base case the in-app design missed. *Active layer*:
the layer's own pixels inside the box at the send scale, read from its levels like `cutoutInput` with the mask applied
like `objectInput` (`host.js:4899-4967`), for a subject generated on flat green over another picture. A filter, text or
reference layer active: the option is disabled with the reason.

**Stated limitations (the manual):** Scumble composites gamma-encoded 8-bit bytes with no linear conversion; a matte
made for linear-light "over" shows soft edges slightly differently from a linear compositor; every mask in Scumble
behaves so and this is not changed here. Speculars above white are clipped.

### 4.4 The hint, and the loop instead of a live preview

| Hint source | Read at send size | Trust sent |
|---|---|---|
| the selection (brush, quick mask Q, wand, shapes, SAM click, *Select by text*, Select by depth / range) | `selectionCanvasSettled(box, scale, w, h)` on tiles (the mask's mip levels, no 600 MB mirror); `sel.drawTo` into a **crop-sized** canvas with a transform on the canvas backend (the depth edit's shape, `inpaint_canvas.js:13666-13680`); the red-alpha canvas becomes a grey PNG (R = G = B = A, opaque) | the dialog's **Hint** row: **Rough (0.5)** by default (a brush, wand, shape or quick-mask selection is a loose scribble in the model's own words: hashu786 `nodes.py:62-66`, upstream README L188-198); **Automatic (0.75)** preselected when `selectionLabel` is set (the selection came from *Select by text*, `inpaint_canvas.js:2212`); **Clean (0.95)** |
| the key layer's own mask after P / E (*Re-key with this mask*, C6) | the layer mask at send size as `objectInput` reads a layer's mask | 0.95 |
| an agent's `select_mask` | becomes the selection, then as the first row; **binary** (`commands.js:1031-1040`): the description says a soft hint needs a layer mask (`set_mask from_layer`) | as given, default 0.5 |
| none | no `alpha_hint` input; `hint_quality` −1 inside, the model decides | — |

Scumble has no selection provenance beyond `selectionLabel`; a `selectionOrigin` field at the `markSelectionChanged`
sites (24 in `inpaint_canvas.js`) would set the trust row by tool, but it changes a shipped file: deferred (question 8).
A feathered selection is a soft hint in [0, 1], which CK2 takes as it is. Pack A resizes a hint to the clip anyway
(`ck_comfy/hints.py:31-37`); the hint PNG goes at the sent size. Polarity is checked at C0 (`invert_hint` is the switch
if a pack reads it the other way).

**Why there is no live preview in phase 1.** The hint enters at CK2's first layer, so a hint change re-runs stage 1 and
2 (about 90 % of a still); neither pack caches the feature models; ComfyUI's cache hits only on identical inputs. A
hint round on ComfyUI is a full key: about 1-3 s warm at 1-4K on the 5090 (inferred) plus the PNG round trip, plus the
model's move back to the GPU unless kept there. Neex's "pretty instant" is not visible in any public code (§2.1). So the
loop is honest: paint, *Re-key with this mask*, seconds, look. The Key dialog, opened with a key layer active, offers
*Re-key with this layer's mask* (C6); it replaces the layer's pixels and mask under one `layerfull` step from the `key`
record's box, scale, screen and source. A quicker substitute, *Preview matte into the selection* (C7), is built only if
Stop B measures a ≤ 1024 px run at about 2 s round trip. The in-app SAM-like loop (encode once, a cheap re-run per
stroke) is phase 2 and a design change, not an extension.

### 4.5 Resolution policy

1. **The box.** With a hint: the selection's bounds grown by context like Generate's crop plan and the Remove tool's
   crop (`renderer/editor/inpaint_remove.js:14-23`): the longer side times 1.5, at least 1024 px (upstream pads to 128
   and a 128 px side failed in one export), clamped to the picture. Without a hint: the whole picture. (C0 compares a
   tight box against a loose one on the user's plate.)
2. **Native up to a cap.** The box goes at its own pixels while its area is at most `KEY_CAP` (default **16 MP**, so a
   4,899 × 3,266 box) and its longer side at most **8,192** (C-RADIO's tested range at H/4). The cap is a setting
   (*Settings › Helpers*, "Key screen: largest size sent at its own resolution"), set from C0's numbers: whether 16 MP
   is a tolerable few seconds in normal mode on the 5090, or 8 MP is the default (§2.2 on the eight-frame estimate).
3. **Scaled above the cap, never refused.** The box is scaled by one factor to fit both limits (`realism.fitAreaSize`'s
   shape, `realism.js:341`), read at that scale straight from the tile levels, keyed, and the answer comes back **to the
   box's size by the app**, not by pack A's `process_scale` (whose upsample would send a native-size PNG back, 600 MB
   for a 15k whole picture, resampled without the picture): the alpha and the fg bilinear, **per band in the window**
   (a small canvas drawn scaled into a band-sized canvas, the band read and written through steps 3-4 of §4.3; never
   `realism.scaleAlpha`, which allocates `ow × oh × 4` bytes for the whole box, `realism.js:425`). The trim uses the
   small alpha's bounding box scaled up. The status says "scaled down to W × H first". A 15k document with a full-frame
   subject always takes this path.
4. **Refined above the cap (C8, decided at Stop B):** the upsampled alpha through a guided filter against the
   full-resolution picture box in a pool job before it becomes the mask. `guidedFar` (`inpaint_depth.js:269`) cannot be
   reused as it is (it normalises by `disparityRange`, inverts and returns u16); a `guidedAlpha` sharing `boxBlurs`
   would be a **new worker op in a shipped file** (`inpaint_worker.js`), so it is built only when C5's live run shows
   the plain upsample too soft on the user's pictures, and then the release block gains the node steps. The kernel
   plan's K24 (`guided_far` in Rust) is where it would move later.
5. **Refused by size:** nothing. Refused before anything is read or sent (one status sentence, `realismWholeCheck`'s
   shape): no ComfyUI connected, no pack, the Inpaint Canvas pack missing, no RTX 30+ CUDA device among the server's
   devices, a run going on the document (`resizingRun`, `providerPending`), the document loading, no picture, a source
   layer without pixels.
6. **Why not tiles:** tiling breaks the global attention the model relies on; seams in a matte are worse than a softer
   matte refined by the picture. The depth path's Detail grid fuses tiles because depth is smooth; a matte is not.

### 4.6 The download and the first run

Phase 1 touches neither Scumble's registry nor its downloader. Pack A's loader downloads the four sets (§3.2) into the
ComfyUI machine's `models/corridorkey2/` on first use. Scumble's job is to make that first run safe and to name the
licences:

- **Scumble sends `auto_download: false`.** A missing set fails in a second with the pack's `FileNotFoundError` naming
  the files (`model_nodes.py:58-62`); `keying.hint(message)` turns it into the dialog's first-run block (§3.3) with the
  two ways to fetch them: run the pack's `scripts/download_models.py` on the ComfyUI machine, or run the loader once in
  the ComfyUI page with `auto_download` on. The `weights` combo of `/object_info` is **not** a presence check: it always
  offers the canonical name (`ck_comfy/paths.py:83-92`) and the foundation files are not visible in it.
- **A download inside a Scumble prompt only if C0 shows it is safe.** Pack A reports its download through
  `comfy.utils.ProgressBar` (`ck_comfy/comfy_utils.py:57-60`, a new bar per file); whether those `progress` frames reach
  Scumble's bar, and whether a Cancel leaves the interrupt flag set until the next prompt, is **unverified** and checked
  at C0. Only then does the dialog get a switch *Let the pack download the models (about 5.1 GB) on the first run*, off
  by default, which sends `auto_download: true` with a 2 h timeout (`comfyPictureRun`'s clock resets only while the
  job is pending, `host.js:3075-3089`) and says the bar is per file. Otherwise the dialog names the script and the
  ComfyUI page only, and Scumble never queues a prompt with the download on (the user's queue would hold a 5 GB
  download for minutes).
- **`keep_on_gpu`:** off by default (the pack's default; about 4.6 GB parked outside ComfyUI's model management on the
  production card between keys, and the next Flux run may need it). A tick in the dialog, *Keep the model on the GPU
  between keys*, off, says that *Free VRAM* (ComfyUI's `/free`) releases it; C0 checks that it does. (Question 6.)
- **Pack B** downloads regardless (the switch shows "the pack decides"); its `unload_other_models` is sent as the
  pack's `evicts` setting, off by default, and the dialog says what the pack does.

### 4.7 The process model

**Phase 1:** nothing of CorridorKey runs in Scumble's process. The run holds the document like a provider run
(`editor.providerPending`, the title row's timer and Cancel, `_providerRuns`); the answer arrives over the proxied
`/view` fetch (no IPC size limit); the decode and the landing run in the window in bands (a 16 MP RGBA PNG is at most
64 MB decoded). `editor.helperUsed` is not set (no in-app model sits in VRAM).

**Phase 2:** the engine runs in an Electron **utility process** like LaMa's (`electron/main/onnx/lama.js:76-86`,
`lama_process.js`), never on main's thread (B5: 24.7 GB after one BiRefNet run; a worker thread killed inside a native
call crashes, `lama.js:16-24`); `kill()` must give private bytes and VRAM back within seconds (a go criterion);
`clearInstances` / `will-quit` / `free()` kill it; `editor.helperUsed = true` on every key, so `freeHelpers`
(`host.js:5357-5362`) frees it before a local ComfyUI run; the answer over IPC at ≤ 1024² (about 20 MB, far under G2's
500 MB).

### 4.8 The command, the assistant, settings

- **`key_screen`** in `renderer/commands.js` after `realism_pass` (`:1479-1502`), the shape of `cutout_layer`: params
  `source` ("picture" default, or a layer), `screen` auto | green | blue, `hint` selection | mask | none, `trust`
  0.5 | 0.75 | 0.95 (default 0.5), `despill` 0-1 (0.5), `download` (only if C0 allowed the switch), `timeout` (600;
  the deadline the way `realism_pass` computes it), later `rekey` (C6) and `preview` (C7). Returns `layerSummary`,
  `seconds`, `box`, `scaled`, `pack`, `status`. The description says a `select_mask` hint is binary. The tool count
  116 → **117** (`README.md:83, 303`, `docs/MCP.md:306`), `docs/COMMANDS.md` by `tools/commands_doc.py`, the `.mcpb`
  by `tools/mcpb_build.js`.
- **`status`** gains `key` readiness as it has `realism`; `list_recipes` is untouched (this is not a recipe: no `task`
  type fits, `electron/main/recipes.js:138`).
- **The assistant:** `key_screen` in `RUNS` (`policy.js:21`), an ask card with the screen, hint and trust.
- **Settings** (`electron/main/settings.js` DEFAULTS, the `realism` precedent at `:20`): `key: { screen: "auto",
  trust: 0.5, despill: 0.5, keepOnGpu: false, evicts: false, cap: 16, timeout: 600 }`; `keying.fillValues` as
  `realism.fillValues`.
- **`host.keySupport()`** like `realismSupport()`, from `keying.serverSupport({ state, os, gpus, objectInfo })`
  (`realism.js:94-128` as the model, `gpuGeneration` imported from there; **no os check**: the packs are CUDA-only, not
  Windows-only). The table of readiness sentences:

| Server state | Sentence (status kind) |
|---|---|
| not connected | "Key screen needs your own ComfyUI with an RTX 30, 40 or 50 card and a CorridorKey 2.0 node pack: connect it under Settings › ComfyUI (Help › Scumble help › Key screen)." (info) |
| CUDA devices, none RTX 30+ | "Key screen needs an RTX 30, 40 or 50 card on your ComfyUI's machine; it shows <name>." (warn) |
| no pack's nodes | "Key screen: your ComfyUI has no CorridorKey 2.0 node pack: install one there (Help › Scumble help › Key screen)." (warn) |
| `InpaintCanvas` missing | "Key screen also needs the Inpaint Canvas node pack on your ComfyUI." (warn) |
| all there | ready; the dialog names the pack found |

- **The entry:** *Image › Key Green / Blue Screen...* (`electron/main/main.js:712-727`, after the Realism Pass; main has
  no server state, so it is never greyed), dispatched like `realism-pass` (`renderer/shell.js:3175`) to a dialog of the
  app's own (`renderer/dialogs.js`, item 25). **No layer-row or context-menu entry in phase 1:** both would live in
  `inpaint_canvas.js` (shipped) and need `host.keyingSupported` in the node's own `js/host.js` (`build_node.py --check`),
  so a node clone, build, commit and push would join the release; deferred to question 8.
- **Screen Auto:** the mean colour of the box's border ring read from the sent bytes, taken outside the hint where
  there is one; B > G means blue; when the ring is neither clearly green nor blue (a subject touching the frame, no
  hint on a tight picture) the dialog asks instead of guessing.

### 4.9 Phase 2: the in-app engine (sketched; not scheduled)

**P2-S0, the spike, measurement only, no app code** (the user's yes for the 2.4 GB; can run any time after C0): Nucito's
fp16 1024² bucket in a scratch folder, in an Electron `utilityProcess` under Electron's Node, per provider `dml` /
`webgpu` / `cpu` (also onnxruntime-node 1.30.0 in a copy of `node_modules`): the session created at all; the nodes
placed on the CPU (ORT verbose placement, `logSeverityLevel 0`); load seconds per graph; private bytes after load and
after one run; VRAM from `nvidia-smi`; run seconds per part at 1024² with and without a hint; the hint loop (stage 1 +
2 on cached features, ten runs, median); parity against **the ComfyUI run's own alpha and fg of the same still** (saved
at C0 through a 16-bit output; no torch venv is needed for the reference); the size ladder 768 → 1024 → 1536 → 2048 and
how each step fails; that `kill()` gives private bytes and VRAM back within 3 s. The user's ComfyUI idle or after Free
VRAM first (the 125 s paging precedent, `HELPERS.md:370-374`). **Go:** one GPU provider loads all five graphs; CPU-placed
nodes ≤ 5 % and none inside the attention blocks; alpha MAE ≤ 2e-3 and max ≤ 0.03 against the reference, fg MAE ≤ 0.01
on alpha > 0.5, no NaN; a still at 1024² ≤ 3 s warm and ≤ 15 s cold; the process ≤ 10 GB private bytes and ≤ 8 GB VRAM,
both back after kill; the hint loop ≤ 250 ms at 768² (≤ 150 ms allows a preview that follows the stroke). **No-go:**
the in-app route stops here with its numbers; the plan says so. An own export (MarcelineVPQ's scripts at opset ≤ 21 with
`MultiHeadAttention`, buckets to 2048; a torch venv of about 3 GB plus the 5.1 GB weights, ffmpeg) is a second
measurement session only on a go, and that repo's LICENSE is read first (a non-permissive licence keeps it out of the
repo).

**On a go, and after Corridor's answers 1-2:** P2-S1 the registry (Light: a `kind: "key"` entry of ten files under
their original names in a **subfolder** `corridorkey2/` because ORT resolves external data by the name inside the
graph and `findFile` looks per subfolder, `models.js:89-95`; **sha256 per file** in the counter `Transform`, `:314-327`
checks size only, HF's LFS oids give the hashes; **the HF token only to `huggingface.co` hosts**, `:298-299` sends it
everywhere today, a `docs/BUGS.md` line now; set progress "file 3 of 10 · 1.2 of 2.4 GB", `fsp.statfs` free disk as
`docfile.js:397`; a pre-download terms dialog with the seat line; `DEFAULTS` / `MISSING` in `index.js:20, 158`,
`settings.js:23`, the row label `shell.js:2079`; NVIDIA's `Notice` beside C-RADIO in any hosted set); P2-S2 the keyer
process (`key_process.js` after `lama_process.js`: five sessions, features cached per picture under
`node.id : layer.id : compositeVersion : box : bucket`, at most two resident buckets, stage 1 + 2 per hint, the pad and
colour code from the README's documented convention as Scumble's own code); P2-S3 the dialog's *In-app* route beside
ComfyUI and the live hint loop (pointer-up on the selection brush → stage 1 + 2 → a screen-only matte overlay with
tickets and `seq` as relight's quick maps, `inpaint_canvas.js:23327-23460`; the full key on Apply through route 1 or the
engine); P2-S4 docs and `HELPERS.md` rows with pinned revisions and hashes. About 5-8 days (inferred).

### 4.10 The manual and the texts

A chapter *Key green / blue screen* (slug `key-screen`) in the Realism Pass chapter's shape (`docs/MANUAL.md:362-406`):
what it does, what you see, what it needs (a ComfyUI with an RTX 30, 40 or 50 card, a CK2 node pack, the Inpaint Canvas
pack), the pack's install steps as its README has them at the commit (`git clone` plus the pip line, dated; the Manager
does not list it), what the first run downloads and under which licences, the seat clause, the hint and its trust, the
Source row, the cap and the scaled path, Re-key, every status sentence explained, the gamma-compositing and 8-bit
notes, the cutout as the alternative without any of it, agents (`key_screen`). README: one feature line under the
helpers. CHANGELOG `## Unreleased` lines per session, the `## 0.1.52 - <date>` section at the release. About (§3.3).

## 5. Sessions

**Rules for every session** (CLAUDE.md "Working rules", `PLAN_WASM_BUILD.md` §1.3): one numbered section per sitting,
its commit as DenRakEiw without a trailer, **the branch pushed** (the user's rule for bigger updates), measurements
committed under `docs/measurements/ck<N>_<date>/`, the hand-over line in CLAUDE.md "Where things stand", a CHANGELOG
`## Unreleased` line for what the user notices, then `/clear`. Every app gate `--offline` with the host stubbed; one
instance at a time; the dev instance on port **9571** from a worktree so the `wasm-kernels` checkout stays untouched
(memory note). **Every live run on the user's ComfyUI only on their word, `/queue` checked first, own prompts taken
off, never a restart.** Stage by explicit path and check `git diff --cached --name-status` (the checkout carries the
user's untracked material). **Tiers:** the pure module and request shapes Light; the run and the banded landing Normal
on both backends (a pixel path) plus the gates the change touches; the UI Normal with `skins`; docs Light; nothing
Full (no Rust kernel, no `.scumble` field, no compositor or export writer; C8 would add a worker op and stays Normal as
a mask path). **No shipped editor file changes in C1-C6**, so 0.1.52 needs no node build; C8 and question 8 would
change that, and then the release block gains the node steps (a clone, `build_node.py --check`, `node_test.py`, the
node commit and push). The behaviour sentence of §1 is repeated in chat before C2, C6 and C8.

Efforts in days, **inferred**.

| # | Session, goal | Files (anchors) | Tests (tier) | Done when | Effort |
|---|---|---|---|---|---|
| **C0** | **The live probe, no app code** (measure before building on a mechanism). **First a code read of pack A at the commit to be installed** (a two-day-old repo by an unknown author, 0 stars, running Python inside the production ComfyUI): every file and `requirements.txt` read for network access beyond the model hosts (HF, Google Cloud Storage), `subprocess` / `os.system`, `eval` / `exec`, pickled loads, obfuscated or downloaded code, writes outside `models/corridorkey2/`; the diff against upstream `485f5e9` for the vendored part; the findings to the user before the install, and the install pinned to that commit. On the user's word: pack A installed on their ComfyUI (`git clone`, its requirements, a restart when the machine is free), the 5.1 GB fetched by the user (the ComfyUI page or `scripts/download_models.py`). `/object_info` of the pack's nodes (and B's if installed) saved to `tools/refs/corridorkey/`. A scratch raw-API script (not Scumble) queues stills: crops of the user's green plate at 1, 2, 4, 8 and 16 MP, with and without a hint, a blue plate, one FLUX 3 subject on flat green; `keep_on_gpu` on and off and whether `/free` releases it; the Advanced node's `info` string (normal or low-VRAM mode); seconds (cold, warm) and `/system_stats` VRAM; the `rgba` PNG read back (8-bit? straight? the polarity of a grey hint through ImageToMask); the despill on blue by eye; a tight box against a loose one; what the pack evicts and the next Generate's reload; one run with `auto_download: true` on a fresh models folder observed on the websocket for `progress` frames and the interrupt flag after a Cancel; a 16-bit alpha and fg of one still saved as P2-S0's reference; a real output cropped to about 512 px saved as the `key` gate's fixture | `docs/measurements/ck0_<date>/summary.txt`, `tools/refs/corridorkey/` | none (a measurement) | **Stop A:** the primary pack confirmed; `KEY_CAP` from the numbers; `keep_on_gpu` and `/free`; `rgba` usable or the two-output fallback (§7); the download switch allowed or not; the hint polarity; blue despill; the flat-green case; the first cost figures for the manual | 0.5 + the user's time |
| **C1** | **`renderer/editor/keying.js`** (app-only, pure): `LABEL`, the pack table, `serverSupport`, `keyPrompt`, `boxPlan(W, H, bounds, cap)` (§4.5: the margin, the minimum, the scale), `screenFromRing`, `trustOption(spec, trust)`, `hint(message)` for the pack's failures (missing models with the file list, "needs an NVIDIA GPU (CUDA)", CUDA OOM, the generic last line), `fillValues`, its own `withSpecDefaults`; `settings.js` DEFAULTS.key. May run before C0 from the clones' specs when the user is away; then its spec fixture is replaced by C0's | new `keying.js`, `electron/main/settings.js`, new `tools/keying_test.js` (the `realism_test.js` shape) | Light: `node tools/keying_test.js` (every text carries the label; the graph for every input combination against the saved spec; the box plan at 1k, 4k, 15k with and without a selection; the ring; the trust mapping), `lint`, `types`, the settings migration test | the test green; the graph validates against `tools/refs/corridorkey/` | 0.75 |
| **C2** | **The run and the banded landing**: `host.keyScreen(editor, opts)` beside `realismWhole` (`host.js:3425-3575`): `keyCheck` (the refusals of §4.5 point 5, `realismWholeCheck`'s shape), the box from the selection's bounds, the picture through `pictureInputBox` or the layer through the `cutoutInput` / `objectInput` shape, the hint through `selectionCanvasSettled` or the crop-sized `sel.drawTo`, both uploaded with `uploadInput` (`host.js:2989`), the token and `providerPending` like `realismWhole` (`:3435-3442`), `comfyPictureRun(editor, prompt, "ck_out", { label, token, timeoutMs, front: true })`, the decode in bands, the trim, the layer and the mask (§4.3 steps 1-5, `"add"` per band, `dirty: true, maskDirty: true, ref: null`), the hide of a source layer, the status sentence, the log line; the scaled path's band upsample in the window (§4.5 point 3); `docs/BUGS.md` gets the HF-token line | `host.js`, `keying.js`, `docs/BUGS.md` | Normal: a new gate `key` = `tools/key_test.py` (every gate name without a rule runs `tools/X_test.py`, `docs/TESTING.md:171-172`) stubbing `host.comfyPictureRun` with C0's fixture (a synthetic PNG of the same format until C0): the layer's bytes and the mask's bytes exactly, the trim box, the hidden source layer, one undo step restores both, **an autosave and a restore bring the mask back**, a refusal, a cancel, the scaled path's bytes within a level; on `--tiles on` and `--tiles off`; plus `editor`, `export` (a keyed layer with its mask exports to PNG, PSD, ORA) | the gate green on both backends | 1 |
| **C3** | **The UI**: *Image › Key Green / Blue Screen...* (`main.js:712-727`; `shell.js:3175`'s dispatch), the dialog (Screen, Hint + trust, Despill, Source, the keep-on-GPU tick, Timeout, the readiness line with *Key* greyed and the reason, the "what goes" line, the first-run block with the licence paragraph and the seat sentence, the download switch only if Stop A allowed it), the title row's Cancel through the token | `main.js`, `shell.js`, `renderer/index.html`, `renderer/dialogs.js`, `host.js` | Normal: the `key` gate's dialog step (the values reach the prompt; the greyed states), `skins` (every skin), `editor`; one look in the app (the user judges looks) | the dialog runs a key end to end on the dev instance against the stub, and once against the user's ComfyUI on their word | 1 |
| **C4** | **The command and the assistant**: `key_screen` (§4.8), `status.key`, `RUNS` and the ask card, `docs/COMMANDS.md`, the count 117 in README and `docs/MCP.md`, the `.mcpb` | `renderer/commands.js`, `electron/main/assistant/policy.js`, `docs/COMMANDS.md`, `README.md`, `docs/MCP.md` | `commands` (a `key_screen` step on the stub), `mcp`, `mcpb`, `assistant`, `lint`, `types` | the gates green; README and MCP.md say 117 | 0.5 |
| **C5** | **Docs and the live run.** The manual chapter (§4.10), the README line, About, `docs/RECIPES.md`, `docs/HELPERS.md`'s table, the CHANGELOG, item 49's hand-over in CLAUDE.md. **The live run** on the user's ComfyUI (the user present, `/queue` first): green and blue stills with and without a hint, Source = active layer on a generated subject, a 15k document with a 4k box (native) and the whole picture (scaled), a Cancel mid-run, the pack missing, the models missing with the switch off (and on, if allowed); seconds and VRAM into `docs/measurements/ck5_<date>/`; the first key judged by eye (the trim, the despill default, the plain upsample's hair) | `docs/MANUAL.md`, `README.md`, `CHANGELOG.md`, `shell.js` (About), `docs/RECIPES.md`, `docs/HELPERS.md`, `CLAUDE.md` | Light for the docs (`help` renders the manual); the live run is the feature's test | **Stop B:** `KEY_CAP` fixed from the numbers; C6, C7 and C8 decided; a defect found means a fix session before the release | 0.5 + the live run |
| **C6** | **Re-key with this mask** (§4.4): the Key dialog with a key layer active offers it; the layer's mask at send size as the hint at 0.95; the `key` record's box, scale, screen, despill and source reused; pixels and mask replaced under one `layerfull` step; `key_screen rekey: true` | `host.js`, `keying.js`, the dialog, `commands.js` | Normal: the `key` gate's re-key step (a painted mask changes the stub's input; one Ctrl+Z restores both), `commands` | the gate green; a round on the user's ComfyUI in seconds | 0.5-1 |
| **C7** (if Stop B says yes) | **Preview matte into the selection**: a *Preview* button and `key_screen preview: true`: the box at ≤ 1024 px long side, the alpha back **into the selection** in bands (`combine` on `this.sel` with `"add"`, one `selection` undo step, as `selectLogits` does), nothing landed; the Hint row switches to Clean (0.95) after a preview | `host.js`, `keying.js`, the dialog, `commands.js` | Normal: the `key` gate's preview step (the selection's bytes), `selection` | a preview in about 2 s round trip on the user's machine | 0.5-1 |
| **C8** (if Stop B says yes) | **The matte refined above the cap** (§4.5 point 4): `guidedAlpha` as a pool op (a new op in `inpaint_worker.js`, **a shipped file**: the release block gains the node steps), the upsampled alpha refined against the full-resolution box before it becomes the mask; the fg stays bilinear. A 15k measurement row (seconds at 8192 → 15000; the edge against the unrefined run) into `docs/measurements/ck8_<date>/` | `host.js`, `inpaint_worker.js`, `inpaint_depth.js` or a new `inpaint_keymatte.js` (shipped: into FILES) | Normal (a mask path): the `key` gate's refine step on both backends; `build_node.py --check` | hair edges on the scaled path judged by the user against the unrefined run | 1 |
| | **Release block** (§6 Q1): the CHANGELOG section `## 0.1.52 - <date>`, `package.json`, the full gate list on both backends, `npm run dist`, `dist:portable`, `dist:store`, the exe gates once on tiles and canvas (`--exe`), the Store notes (`dist/store-listing/whats-new-0.1.52.txt` covering 0.1.48-0.1.52: the Store is at 0.1.47); the node steps only if C8 or question 8 changed a shipped file; the release chain on the user's word (`docs/RELEASING.md`: push, tag, the CI draft, publish, the post, `server.json` and the MCP Registry, the Store upload); then `main` merged into `wasm-kernels`, the kernels' `## Unreleased` line placed above 0.1.52's section | | | | 0.5 |

**Phase 1 total (inferred):** about 4.5-5.5 days for C0-C5 plus the release block; 6-8 with C6-C8. The Realism Pass
took R1-R5 at about the same size. **P2-S0** (1 day) may run any time after C0 on the user's yes for the 2.4 GB; the
phase 2 build (§4.9, about 5-8 days) only on its go and Corridor's written answers, and not on `wasm-kernels`.

**Stops:** A after C0 (the pack, the cap, the switch, the output format), B after C5 (C6-C8; a defect), and P2-S0's
go / no-go.

**Where it lives (the critics and all three designs agree; the user's question 1):** a branch **`corridorkey` off
`main`** in a worktree, pushed after every session; **released as 0.1.52 on the user's word after C5** (or after C6-C8 if
Stop B adds them), then `main` merged into `wasm-kernels` as 0.1.51 was (`PLAN_WASM_BUILD.md` §7 "G2"). Reasons: the
kernel update is 40-48 days of sessions with one release at the end, and the user's "one release at the end" is the
rule for *the kernel work* (the user's reading on 2026-10-24: a fix of released code is not bound by it; a feature with
Corridor's fresh yes is a step further, hence the question); CK touches no kernel, no `.scumble` field, no compositor,
no export writer, and in C1-C6 no shipped editor file, so the later merge is small (`host.js` is the one shared file,
K0a's marks in `saveExport`); `main` stays the release state between sessions. The alternative, building on
`wasm-kernels` and shipping with K41, keeps the sessions the same and changes only the branch and the CHANGELOG place.
Two costs of a release in between, named: the Store backlog (the 0.1.48-0.1.51 MSIX uploads are still the user's open
drag and drop; the 0.1.52 notes cover them) and the CHANGELOG merge.

## 6. Open questions for the user

Each with the recommended answer; where nothing is said by the session that needs it, the recommendation is taken and
the hand-over says so. Numbers the measurements produce (the cap, the preview's speed) are not asked: Stops A and B
answer them. Licence-required texts (the seat sentence, the first-run paragraph) are stated, not asked.

1. **Branch and release (before C1).** A `corridorkey` branch off `main` in a worktree, sessions pushed, **0.1.52 after
   C5 on your word**, then `main` into `wasm-kernels`? Or build on `wasm-kernels` and ship with the kernel release?
   *Recommended: the branch and 0.1.52.* (Memory note: no release is offered after each step; this is one release for
   the feature, asked once.)
2. **Pack A on your production ComfyUI (before C0).** Install marawan206/ComfyUI-CorridorKey2.0 (a clone into
   `custom_nodes`, its requirements, a restart when the machine is free; the 5.1 GB into `models/corridorkey2/`)?
   Pack B stays a documented alternative. *Recommended: yes, pack A; C1 first if you are away.*
3. **The landing (before C2).** A new layer with the unmixed foreground as pixels and the matte as its layer mask; a
   source *layer* hidden in the same undo step; the base left as it is (it cannot be hidden; a background layer under
   the key covers it)? *Recommended: yes.*
4. **Trim (before C2).** The landed layer trimmed to the matte's box plus 2 px, or the whole sent box? *Recommended:
   trim.*
5. **Naming (before C3).** The action "Key green / blue screen", the layer "Key", "CorridorKey 2.0" in the dialog's
   licence line, the status, About and the manual (the licence's §4 wants the name; your rule allows a model's name
   where the text is about running it). *Recommended: as written.*
6. **`keep_on_gpu` (before C3).** Off by default with a tick in the dialog (about 4.6 GB held between keys when on;
   Free VRAM releases it, checked at C0), or on by default to save the 10 s reload per round? *Recommended: off.*
7. **The in-app spike P2-S0 (before it runs).** A day of measurement and a 2.4 GB test download into a scratch folder,
   any time after C0; the phase 2 build only on its go and Corridor's written answers, after the kernel update's
   release. *Recommended: the spike when you want the numbers; the build later.*
8. **Entries in shipped files (before C3).** A layer-row or context-menu entry for Key / Re-key and a `selectionOrigin`
   field that sets the trust row by tool both change `inpaint_canvas.js` and need `host.keyingSupported: false` in the
   node's own `js/host.js`, so the release would carry a node build. Now, or a later update? *Recommended: later; the
   Image menu and the dialog carry phase 1.*
9. **Corridor's written questions.** The thank-you reply drafted on 2026-10-24 already asks 1-3 and 5 of §3.4 in short
   form; send 4, 6 and 7 (and whatever is still unanswered) after C0, in the same thread or by email? *Recommended:
   yes, after C0, so the message can say what we built and measured.*
10. **Keying the base shows nothing at first (before C2).** The base cannot be hidden (§2.4), so a key of the base
    photo lands a layer over the same photo and the screen still shows through where the matte is 0: the user sees no
    change until something replaces the background. Options: (a) leave it, the status says "add a background under
    the Key layer"; (b) **land a mid-grey Fill layer between the base and the key in the same undo step** (the key is
    visible at once; the grey layer is the obvious one to replace or delete); (c) make the base transparent, if an
    existing operation can (C2 checks; the manual says tools never change the base, and the PSD import already lands a
    transparent base, `inpaint_canvas.js:18576`). The dialog's Source row would carry the choice when the source is the
    base. *Recommended: (b) by default, (a) as the dialog's other option; (c) only if C2 finds it is an existing
    operation.*
11. **Store policy 11.16** (the live generative-AI disclosure, in force since 7.19): was it ticked in the 0.1.47
    submission? *Recommended: check in Partner Center at the next Store update; not CK-specific.*

**Decided here, not asked:** despill 0.5 for both screens with pack A (its despill reads `screen`); 0 for blue with
pack B (green-only); the hint trust defaults of §4.4; the cap measured at C0 (start 16 MP, 8,192 px a side), scaled
above it by the app, never `process_scale`; `auto_download: false` always, the download switch only if C0 shows the
pack's progress reaches the bar; `withSpecDefaults` copied, not moved; no Comfy Cloud and no paid host.

## 7. Risks, and what changes the plan

- **Both packs are days old with no history.** Their inputs may change or the repos may go. Mitigation: one small graph
  builder per pack, the pack identified by node classes, `withSpecDefaults` for required inputs added later, the specs
  saved in `tools/refs/corridorkey/`, the manual's install steps dated to the commit. **Changes the plan** if neither
  keys a still correctly or both vanish: a thin `CorridorKey2` node inside the Inpaint Canvas node pack that *imports*
  the `corridorkey` Python package the user installs (no vendoring, so no CK-licensed code in the GPL repo; whether an
  import counts as "incorporating" under §2(c) / §5 is a question for Corridor), or waiting for an official pack.
- **The measurement at Stop A.** If 16 MP falls into low-VRAM mode or takes more than about 10 s on the 5090, the cap
  drops to 8 MP and more keys go scaled; if even 8 MP is slow, `low_vram: "on"` through the Advanced node. If a
  one-frame clip cannot run 1/1 in pack A, pack B. If a synthetic flat green keys badly, the dialog gets a note and the
  feature is for photographed screens in this release.
- **The first run's 5 GB download inside a prompt** against `comfyPictureRun`'s clock and the user's queue. Mitigation:
  `auto_download: false` always; the switch only on C0's evidence; else the pack's script and the ComfyUI page.
- **The `rgba` output's bytes.** Premultiplied, inverted or linear would break the landing. C0 reads the PNG; the net is
  a second output: `comfyPictureRun` learns `outputs: [fgId, alphaId]` (two `PreviewImage` nodes on `foreground` and
  `alpha` through `MaskToImage`), one more branch in its wait (`host.js:3054-3073`), not a redesign.
- **VRAM and the user's other models.** Pack A's auto window asks ComfyUI to unload other models and offloads CK2 to RAM
  after a run; the next Generate reloads Flux (seconds). `keep_on_gpu` holds 4.6 GB. Stated in the manual; question 6.
- **The hint polarity and channel** (ImageToMask red of a grey PNG). Checked at C0; `invert_hint` is the switch.
- **Compositing in gamma space; 8-bit clip.** A matte made for linear-light "over" can show a faint halo on hair against
  a bright background. Known limitation, in the manual; a linear "over" for masked layers is a compositor change (Full
  tier, another update). If the user's pictures show it badly, the layer's Match slider and the mask are the tools.
- **Sizes.** A user whose documents are mostly 15k lives on the scaled path. If C5 shows the plain upsample too soft, C8
  moves up (and carries the node steps). If other users' cards are smaller than the 5090 (none today), the cap is read
  per server from `/system_stats` VRAM, not a constant.
- **Licence.** Phase 1 ships no CorridorKey code and hosts nothing, so the release does not wait on Corridor; a quiet
  Corridor delays only phase 2. Should Corridor answer differently in writing than on Discord, the exposure is the
  texts and the feature's presence, and the user decides. Any converted weights are hosted only on their written yes.
  The free Store copy stays free.
- **Production machine.** C0 and C5 only with the user present, `/queue` checked, no restart of their ComfyUI by
  Claude; the gates run `--offline` with the host stubbed.
- **The in-app route's odds.** DirectML in maintenance mode, the B5 memory blow-up, no CUDA in onnxruntime-node on
  Windows, no export above 1024 px. Phase 1 does not depend on it. **Changes the plan in the good direction only:**
  a WebGPU stage 1 + 2 at 1024² well under a second with correct output and bounded memory would make hint painting
  live and the loop SAM-like (encode once, a cheap re-run per stroke); then the in-app route becomes the preview and
  ComfyUI the final key for large boxes.
- **What would make this plan drop ComfyUI first:** Corridor publishing an official ONNX export with hint-only re-runs
  *and* P2-S0 measuring a stable GPU provider at 2K with the memory given back. Nothing read today points that way.
- **Unverified until C0:** every timing on the user's card; the pack's `rgba` being straight and 8-bit through
  `PreviewImage`; the progress frames during the pack's download reaching Scumble's bar; `/free` releasing a model kept
  on the GPU; the flat-green generated case; blue-screen despill quality; the effect of a key on the user's Flux runs.

## 8. Sources (read 2026-10-24)

- The five research reports, committed under `docs/research/ck2_2026-10-24/`: `pipeline.md`, `licences.md`,
  `onnx.md`, `comfyui.md`, `app.md` (each with its fact list and sources; the section references in this plan, such as
  "`pipeline.md` §4", point there). Not committed (third-party code, the planning session's scratchpad only): the clones
  `ck_comfy/` (the two CK2 packs, upstream
  `485f5e9`, ComfyUI v0.42.4 core files, the Inpaint Canvas node's `nodes.py` at `4e7bd24`), `ck_pipeline/`,
  `ck_licences/` (the licence texts, NVIDIA's OML extracted).
- nikopueringer/CorridorKey2.0 @ `485f5e9` (code), `nikopueringer/CorridorKey2.0` @ `cf44a8d` (weights, LICENSE);
  marawan206/ComfyUI-CorridorKey2.0 @ `eeee7fa`; hashu786/ComfyUI-CorridorKey2 @ `141c31b`; Nucito/corridorkey-web
  @ `1ae72ca`; MarcelineVPQ/corridorkey-desktop @ `372f042` (docs only); peterteravskis/corridorkey-v2-mlx
  (benchmarks); corridorkey.com (the seat prices); the Microsoft Store Policies 7.20.
- Scumble at `ec1142b`: the anchors named above; `docs/PLAN_0_1_42.md` (the Realism Pass as the model for a helper
  route on the user's ComfyUI), `docs/PLAN_RELIGHT_BUILD.md` and `docs/PLAN_WASM_BUILD.md` (the rules and the shape).
