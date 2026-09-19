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
`host.upsampleInApp()`; the host members the editor calls are in docs/BUILD_NODE.md.

### Through the ToAPIs key

A stored ToAPIs key (the image provider, docs/RECIPES.md "ToAPIs") adds three rows **at the top** of
the list: Gemini 3.8 Flash, Claude Haiku 4.5 and GPT-5.6 Terra, ids `toapis:<model>`. ToAPIs' `POST
/v1/chat/completions` is OpenAI-compatible with vision and data-URI images, so the rows go through the
same client as the local endpoint below (`askCompatible` with `<think>` stripping), at the host
`providers/toapis.js` allows (`settings.toapis.base`, else `https://toapis.com`) plus `/v1`, on the
ToAPIs key; an unreachable host names ToAPIs. All three rows see images, so the client runs **strict**
there: the retry without the image happens only for a 400 / 413 / 415 / 422 whose message names the image
(the status line then ends with "text only", as for a local model), never for a refused key (401), an empty
balance (402), a forbidden model (403), a rate limit (429) or a server error, which a second request cannot
fix; those fail at once with the image adapter's plain words in front of ToAPIs' message ("key refused",
"balance too low, top up at toapis.com", "rate limited"). Before the review of 2026-09-15 any 4xx was
retried without the crop and the "text only" note was dropped on this path. From ToAPIs'
catalogue on 2026-09-15 the three cost about $0.30 / $1.50 (Gemini, Claude) and $0.40 / $2.40 (GPT) per
million tokens in / out, roughly a tenth of a cent for one rewrite with the crop. Left out: GPT-5.6
Luna (no public price) and the `-official` text channels (three to four times the price for a prompt
rewrite). **Not run against the live API**; `tools/llm_test.py` checks the rows' order, that they come
and go with the key, and that the request reaches the endpoint with the crop and the ToAPIs key
(`tools/llm_mock.py` answers the three ids), and section 8 of `node tools/toapis_test.js` the strict
retry rule, the plain words and the "text only" note against a scripted fetch.

### Through the OpenRouter key

A stored OpenRouter key (the image provider, docs/RECIPES.md "OpenRouter") adds four rows **after the
Anthropic rows**, the last of the key rows (the ToAPIs rows stay first; a local endpoint's entry, below,
comes after them): Gemini 3.8 Flash (`google/gemini-3.8-flash`), GPT-5.6 Luna (`openai/gpt-5.6-luna`), Claude Haiku 4.5
(`anthropic/claude-haiku-4.5`, with a dot; the hyphenated id does not exist there) and Mistral Small 4
(`mistralai/mistral-small-2603`), each labelled "(OpenRouter key)", ids `openrouter:<model>`. They go
through the same client as the ToAPIs rows (`askCompatible`, strict, `<think>` stripping, 120 s timeout) to
`POST <base>/api/v1/chat/completions`, where the base is what `providers/openrouter.js` allows
(`settings.openrouter.base`, else `https://openrouter.ai`), with the text first and the crop as a data-URI
`image_url` part after it, as OpenRouter's image-input page recommends. From `GET /api/v1/models` on
2026-09-19 they cost, per million tokens in / out, $0.75 / $3.75 (Gemini 3.8 Flash), $0.20 / $1.20 (GPT-5.6
Luna), $1 / $5 (Claude Haiku 4.5) and $0.15 / $0.60 (Mistral Small 4, on Mistral's own hosts in France).
Left out: Claude Sonnet / Opus 5 and GPT-5.6 Terra (6 to 25 times Luna's price for a prompt rewrite), and
the Qwen vision models: Qwen3.8 Flash, Qwen3.7 Flash and Qwen3 VL 32B have Alibaba as their only host, which
the ignore list below leaves out, so they would fail with a 503.

**Reasoning, per row** (`reasoning` in `MODELS`, sent as OpenRouter's `reasoning` object): Gemini 3.8 Flash
and GPT-5.6 Luna send `{ effort: "low", exclude: true }`, the lowest effort each takes (Gemini 3.8 Flash
reasons always, so `effort: "none"` would be refused with a 400; GPT-5.6 Luna reasons at medium by default).
`exclude` keeps the reasoning out of the answer; it is still billed and counts against `max_tokens` (4096 by
default). Claude Haiku 4.5 and Mistral Small 4 send no field and do not reason: on OpenRouter Anthropic's
models reason only when the `reasoning` parameter asks, and Mistral Small 4 has reasoning off by default.
The switch stays in the main process: `llm.list()` hands the renderer `id`, `provider`, `model`, `label`
and `key` only.

**Routing.** Every request carries `provider: { data_collection: "deny", ignore: [the hosts in China] }`.
`deny` means "use only providers which do not collect user data", which is about training: hosts that keep
prompts are not left out ("OpenRouter does not have routing rules that change based on data retention
policies of providers"), and a model with no host left fails with a 503. The ignore list is the image
adapter's (`chinaHosts`: `GET /api/v1/providers` once per session, merged with the list of 2026-09-19).
On 2026-09-19 none of the four rows routed to a host in China with its plain id (Gemini: Google AI Studio
and Vertex; GPT-5.6: OpenAI, Azure, Bedrock; Claude: Anthropic, Azure, Bedrock, Vertex, Claude Platform
on AWS; Mistral: Mistral), none of those hosts trains on the data, and they keep prompts for none (Vertex,
Azure, Bedrock), 30 days (Anthropic, Mistral), 55 days (AI Studio) or a period not given (OpenAI), per
OpenRouter's undocumented provider list (`GET /api/frontend/v1/all-providers`). `zdr: true` is not sent;
with it GPT-5.6 would be left with Azure's endpoints alone, which list `max_completion_tokens` but not the
`max_tokens` this client sends (whether OpenRouter translates one into the other is not stated).

**Errors and retries.** The strict rule of the ToAPIs rows: the retry without the image only for a 400 /
413 / 415 / 422 whose message names the image (then the status line ends with "text only"), never for a
refused key (401), missing credits (402), a refusal (403), a rate limit (429) or a server error. Apart from
that retry this path sends nothing a second time, not even a 429, which the image adapter sends once more
after `Retry-After`. A failed answer is read
the way the image adapter reads one (`openrouter.readFailure`: the message and `error.metadata`), and its
plain words (`openrouter.explain`) go in front of OpenRouter's message: "key refused", "credits too low, top
up at openrouter.ai/credits", "this key's spending limit is reached" for a 402 of the key's own limit, "recent
paid requests are still settling" for the in-flight budget, "refused by the content policy" with the
moderation `reasons`, "rate limited" and the rest of docs/RECIPES.md "OpenRouter". The key is taken out of
every message, the ones inside an HTTP 200 included: `llm.ask()` does it for every row of every provider (a
key of 12 characters or more, so a local server's placeholder key such as "ollama" is left alone). An error that arrives inside an HTTP 200 after the answer began
(`finish_reason: "error"`, which OpenRouter documents with partial content) fails with its message instead
of the partial text becoming the prompt; a 200 that holds only an `error` object fails with its message as
before. A **refusal** (`finish_reason: "content_filter"`, the reason in `message.refusal`, OpenRouter's
contract for a model that declines, e.g. Anthropic's `stop_reason: "refusal"`) fails with "refused: <the
reason>", and whatever content came with it is not taken as the prompt; this holds for every row that goes
through the OpenAI-compatible client.

**No attribution headers** go out (`Content-Type` and `Authorization` only; docs/RECIPES.md "OpenRouter",
"Privacy"), and **the key rule** of the image adapter holds: a key that starts with `test-` goes only to the
loopback mock, any other key never there, both refused before a request. **Not run against the live API.**
Section 11 of `node tools/openrouter_test.js` checks the rows' place in `llm.list()`, the body (the
reasoning switch per row, the routing object), the strict retry rule, the errors inside a 200 and the key
rule against a scripted fetch; the gate `openrouter` (docs/RECIPES.md "OpenRouter", "Tests") sees the rows
come with the key, after the ToAPIs rows, and upsamples on the Gemini row against `tools/openrouter_mock.py`,
which answers the four ids on `/api/v1/chat/completions`.

### A local or self-hosted OpenAI-compatible endpoint

Any server that speaks `POST /v1/chat/completions` joins the same list without a provider
key: Ollama (`http://localhost:11434`), LM Studio (`http://localhost:1234`), vLLM, a proxy.
For OpenRouter use its own rows above: pointed at from here, it would go without the
routing object, the reasoning switch and the strict retry rule, with the key stored as
`compat`. Settings › Local / OpenAI-compatible endpoint has the URL, the model and an
optional key (secret name `compat`; local servers want none). The values live in
`settings.llm.compat = { url, model }`, the entry appears as `compat:<model>` in `llm.list()`
and as `app:compat:<model>` in the editor's upsample select as soon as both fields are
filled; saving either field calls `host.refreshLLMs()`, so the select updates without
reopening the dialog.

- The URL may end in `/v1` or not, a trailing slash is stripped.
- *Test* asks `GET <base>/models` (IPC `llm:models`) and fills a `<datalist>` on the model
  field with what came back; the state line names the first three.
- The image goes as a `data:` URI in an `image_url` content part. **A text-only model gets
  one retry without the image** (a 4xx answer, or an error that mentions images or vision),
  and the status line then ends with "text only" so it is clear the model never saw the crop.
- A `<think>...</think>` block is stripped from the answer (Ollama's Qwen3 and DeepSeek put
  their thinking into the content); `reasoning_content` is ignored. The quote and code-fence
  stripping of the other backends applies afterwards.
- Timeout 120 s (a local model on the CPU is slow). A refused connection reads
  "No server at &lt;url&gt; (is Ollama / LM Studio running?)".

**No real local server has been tried.** The gate is `python tools/llm_test.py`, which runs
`tools/llm_mock.py` (a mock endpoint with a vision model and a text-only one) in a thread and
drives the running app over CDP: the backend is listed, the vision model sees the crop, the
text-only model triggers exactly one retry without the image, and with the mock stopped the
error names the URL. It puts `settings.llm` back at the end.

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
`host.*` calls in the editor (`docs/BUILD_NODE.md`). The renderer scales the source to 1024 × 1024 with
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

**The folder scan** (`scanFolder` / `matchScan` in `models.js`, 2026-09-12). A ComfyUI
models folder rarely holds our file names, so `locate()` alone found nothing there. The scan
walks the folder once (depth 6, 50,000 files, hidden folders and `__pycache__` skipped,
symlinks never followed) and attributes every `.onnx` file to a registry entry by its exact
name, by the exact byte size the registry carries (only when that size is unique in the
registry: the four SAM2 decoders share one size and must never be swapped), or by the
Hugging Face snapshot layout (`ONNX_ALIASES`, e.g. `RMBG-2.0/onnx/model.onnx`). A model
whose files were all found gets `settings.helpers.links[id][role] = path`; `locate()`,
`paths()` and `describeAll()` take the links, and a linked model is `linked: true` with the
relative path in `rel`. The weights the ComfyUI nodes use (`OTHER_WEIGHTS`: `.safetensors`,
`.pt`, `.pth`, `.bin`) are reported per model in `elsewhere` and never loaded, because ONNX
Runtime cannot read them. `helpers.configure({ dir })` scans the new folder at once,
`helpers.scan()` (IPC `helpers:scan`) on demand; the result is kept in `settings.helpers.scan`
until the next scan. *Remove* on a linked model only drops the link.

Measured on the user's ComfyUI folder on 2026-09-12: 1,396 weight files in 123 folders in
77 ms, **nothing linkable** - SAM2 tiny and base+ are there as `.safetensors`, RMBG-1.4 as
`.pth`, RMBG-2.0 as a `model.safetensors` snapshot, all reported as "present only as PyTorch
weights". So on a typical ComfyUI install the scan explains the situation rather than
saving a download; it saves one where someone has put the ONNX exports into the folder.

Gate: `node tools/scan_test.js` (a synthetic ComfyUI folder with files truncated to the
registry sizes, twelve checks, no models needed); `node tools/scan_test.js --dir <folder>`
prints the report for a real folder.

## Settings › Helpers

Device (auto / GPU / CPU; changing it frees the sessions), the SAM2 model for the
object tool, the model folder (Change folder … / App folder / Open folder / Scan folder,
with a summary line of the last scan), one row per
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
