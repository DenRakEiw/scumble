# Mirage (Cactus Compute) as an add-on beside SAM2 / SAM3 (research, 2026-11-07)

The user (2026-11-07, for the coming update): "prüfe ob wir mirrage als sam 2/ 3 ersatz nehmen können (also add on nicht
ersatz)", with https://cactuscompute.com/blog/mirage. A workflow of five (two web researchers, a reader of Scumble's
helpers, an assessor, a critic that checked every key claim at its source); the raw results in `workflow_results.json`.
Nothing downloaded, nothing run. Read 2026-11-07; the model is two days old.

## What Mirage is

- Cactus Compute's on-device vision model, released 2026-11-06: 51.3M parameters, 21.6 MB as a 2-bit `.cact` file
  (`mirage.cact`, sha256 4249a0f7...), an fp32 `mirage.safetensors` of 216 MB beside it; Hugging Face
  `Cactus-Compute/mirage`, not gated. No ONNX, GGUF, CoreML or TFLite.
- **One RGB picture in, one JSON record out**: a scene description, up to 64 objects with free-text names (from its
  language decoder, en / de / fr / es / it / nl / pl), attributes, boxes on 0-1000 and coarse instance masks (YOLACT style:
  32 shared prototypes on a 128 x 128 grid over a 512 px letterboxed canvas, binary at 0.5, cropped to the box), up to 32
  OCR text lines (a CTC reader), relations, events, short form answers, a reasoning trace.
- **Not promptable**: `cactus_describe(rgb, width, height, options, language, keywords, out)` (cactus.h of engine 4.0.0)
  takes no point, box or text that steers the segmentation. It proposes; it cannot be asked for "this" object.
- **Quality is unmeasured**: no box / mask AP, no OCR benchmark, no comparison with SAM; the only number is a VQA proxy
  (31.3 of 100 on 256 VQAv2 questions read through Qwen3-0.6B). The authors name the mask limits themselves (thin
  structures lost, the 128 grid, tight boxes clip, polygons without holes). `seg_loss: 0.0` in config.json is unexplained.
- **Speed**: 74 ms on a Galaxy S26's NPU, 107 ms on its CPU (the blog); nothing for Windows x64. Issue
  cactus-compute/cactus#188: the native engine collapses when it shares cores (120-170 ms on 16 cores, 19 s on 6, 147 s
  on 2), with no thread setting.
- **Runs only on Cactus's own engine 4.0.0**: prebuilt binaries (Windows x64 / ARM64, Linux, macOS, Android, iOS, and a
  wasm build "for Browser and Node.js": `cactus.js` 63 KB + `cactus.wasm` 1.24 MB, SIMD128, single-threaded, no
  SharedArrayBuffer, no remote URL in the glue) on Hugging Face `Cactus-Compute/cactus`, tagged Apache-2.0, **source not
  public** (the manifest's source commit is in no public repo). The model code (JAX) is not public either.
- **Licences**: the weights apache-2.0 in the model card's metadata only (added 2026-11-06, no LICENSE file); the Python
  client (github.com/cactus-compute/cactus) Apache-2.0 and sends telemetry by default; the older engine repo
  cactus-compute/engine has a non-OSI licence (free only for individuals, non-commercial use and organisations under
  US $2M): never build from it. Training data and any teacher model undisclosed.

## What it would add to Scumble (and what not)

- **Point select, box drag, `select_point`: nothing** (no prompt input). SAM2 stays.
- **Cutout: nothing** (no matting, binary coarse masks). RMBG / BiRefNet stay.
- **Select by text without ComfyUI** (today it always needs ComfyUI: SAM3 through comfyui-rmbg, GroundingDINO + SAM, or
  core SAM3): describe the picture, match the object names against the typed words, send the matching boxes to SAM2 as
  box prompts (sam2.js `predict(emb, points, box)`, corners labelled 2 / 3), join the masks. Limit: it finds only what it
  proposed (64 at most), and names may be wrong.
- **Names in the objects tool** (tool O, hover, `host.findObjects`): "mug, red" instead of unnamed SAM2 segments.
- **Named Keep boxes** for FLUX 3 / Ideogram 4 box prompting (PLAN_BOXES §11 S4 writes "object k" today and asks for "a
  vision model that lists the main elements with their boxes").
- **Select text by OCR** (to remove or replace lettering), accuracy unmeasured.
- **A scene record for the assistant and MCP agents** (a `describe_image`-like command).

## Routes

- **A (recommended, after a spike): the wasm build in a renderer Web Worker with a small loader of our own** (the glue
  needs 16 imports; `renderer/index.html`'s CSP already allows `'wasm-unsafe-eval'`, `inpaint_worker.js` already
  compiles wasm from bytes; no Node rights, no third-party JS, cancellable). `cactus.wasm` and `mirage.cact` a pinned
  download with sha256 through Settings › Helpers (the engine pinned on its manifest, ENGINE_REVISION 1a028f5a), never in
  the installer. The masks never land raw: each box goes to SAM2. Alternative: the vendor glue in a utility process
  (LaMa's pattern).
- **B (fallback only): the native libcactus.dll** from the Python wheel through FFI (koffi, MIT) in a utility process:
  only if A is too slow; the core-sharing collapse (#188) beside Scumble's own pool and ComfyUI is the risk.
- **C: a ComfyUI helper node: not recommended** (no node pack exists; pip on the user's production machine, telemetry;
  SAM3 already covers text selection there; the point of Mirage is a small offline CPU model, which belongs in the app).
- **D: our own ONNX port: no** (no model code; reverse-engineering 583 Flax tensors, parity only against the closed
  engine; weeks).
- Excluded: the WASI component (no `describe`), `cactus.exe` (no documented picture flag).

## Blockers and conditions

1. A downloaded **executable component whose source is not public** (wasm, or a DLL) is new for Scumble (today only
   model data is downloaded; ORT ships in the bundle): the user's decision.
2. **Microsoft Store policy 10.2.2** (no downloaded code that extends the described function): in the Store copy the
   feature must be described in the listing or switched off. Flathub's resubmission: the same question.
3. Quality and speed on Windows unknown: a spike decides.

## The spike (0.5-1 session, scratchpad only, no app code; the download only on the user's yes)

Node loads `cactus.js` / `cactus.wasm` and `mirage.cact` (about 23 MB from Hugging Face, pinned, sha256-checked), runs
`describe` cold and warm on 10-20 of the user's pictures (scaled to 1,024 px first), counts invalid JSON (`nan`), reads
the bbox order and the RLE layout, compares Mirage's masks with SAM2 box prompts on 5 objects, tries `keywords` for "the
red mug", checks German names against German words, and runs with the network blocked. Then the build decision; the
build through route A about 4-6 sessions (inferred): the registry, downloader rows and the worker (1), the host members,
names on hover, the SAM2 refinement (1-1.5), selection by name as an in-app backend, the MCP texts, a gate step (1), more
for OCR and the scene record.

## The user's answer (2026-11-07)

"ja, für ein nächstes update, nicht jetzt ;)", with the weights' page https://huggingface.co/Cactus-Compute/mirage/tree/main
(the files listed above: `mirage.cact`, `mirage.safetensors`, `config.json`). So: not in 0.1.52; the spike, its download
included, goes with a later update. The questions below stay open until that update is planned.

## Questions for the user

1. A Cactus engine without public source (Apache-2.0-tagged binaries) as an optional download, not in the installer: yes,
   or only once Cactus publishes the source?
2. The spike's download (about 23 MB into the scratchpad, pinned and checked) and runs on 10-20 of your pictures: yes?
3. Which uses matter: selection by name without ComfyUI, names on hover, named Keep boxes, OCR text selection, a scene
   record for the assistant and MCP?
4. Not in 0.1.52 (already large), the update after it: agreed?
5. Write to Cactus (a LICENSE file in the model repo, the engine's source, redistribution by a GPL app, training data)?
   Claude drafts, the user sends.
6. Store and Flathub: the feature switched off in the Store copy and on Flathub, or described in the listing?
