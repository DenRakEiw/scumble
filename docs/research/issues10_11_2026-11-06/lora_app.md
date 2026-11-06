# lora_app

## Summary

The design hinges on three facts. (1) Settings rows can't carry LoRAs. A recipe has at most 8 slots (RECIPES.md:330-332, recipes.js:198), and flux3_klein_local and moss_image_local already use all 8. toPrompt maps a row's index to canvas slot 13+index-1 (recipes.js:1009), so a 9th row would land on box_prompt's slot. LoRAs therefore need their own list, spliced into the queued copy of the graph at run time, following the precedent of comfyprompt.wireUpsampler (comfyprompt.js:294). The splice point is host.queueGenerate: after the Settings rows are written (host.js:4107-4111), the box wiring (4118) and wireUpsampler (4124), and before api.queuePrompt (4142). (2) One generic rule covers every shipped local recipe. Find the single live node with a MODEL output and no MODEL input (object_info `output` = RETURN_TYPES, server.py:849). Insert a chain of LoraLoaderModelOnly nodes (nodes.py:761) and point every input that read [source, slot] at the chain's end. That catches flux3_klein's two consumers (BasicScheduler and CFGGuider) and the switch branches of the Comfy Cloud templates. All 5 local edit/generate recipes have exactly one UNETLoader and a separate CLIPLoader, so model-only LoRAs are enough. The three recipes without a MODEL output (realism_pass, rtx_vsr_local, upscale_model_local) drop out by themselves. Only cloud_ideogram_4 has two MODEL sources. (3) Most failures are silent. A LoRA trained for another base model only produces "lora key not loaded" or "SHAPE MISMATCH ... NOT MERGED" in ComfyUI's log (comfy/lora.py:102, :536), and the run succeeds unchanged. The user's server holds 580 LoRAs, mostly SDXL, in architecture subfolders with Windows backslashes. The list is read once at connect (host.js:1287, 1360). A file missing on the server needs a refusal before the run, like missingFilesRefusal (host.js:1622). Storage: per recipe in settings.json, like recipePresets (host.js:1449-1461), needs no format change. Per document inside `gen` survives older apps as an unknown key (DOCUMENTS.md:171, 317-319). The UI goes through a host hook (renderPresets precedent, host.js:1497), with a no-op in the node's js/host.js:113 (build_node.py --check enforces this). No API adapter sends LoRAs today. fal's LoRA endpoints take `loras:[{path,scale}]` with URLs, which is a separate design. Comfy Cloud would splice in main (comfycloud.js:394-430), with LoRAs from the user's account that its node list doesn't show.

## Report

## Scope and sources
Read only F:\canvas (branch wasm-kernels), plus read-only files of the user's ComfyUI (v0.42.4, F:\Comfyui\ComfyUI_windows_portable_nvidia\ComfyUI). ComfyUI was **not running** (curl to 127.0.0.1:8188 got no connection), so no /object_info was read live; the node specs come from nodes.py instead. The issues were checked with gh: #10 https://github.com/DenRakEiw/scumble/issues/10 and #11 https://github.com/DenRakEiw/scumble/issues/11. Scratch analysis: C:/Users/SCHOEN~1/AppData/Local/Temp/claude/F--canvas/543d44fb-4d2d-4818-8804-974916d10a44/scratchpad/iss_lora_app/model_tree.txt and .../analysis2.txt (scripts analyze.py and model_tree.py in the same folder). Every claim below is marked [read], [inferred] or [unverified].

## 1. Every graph-carrying recipe: model loaders, the MODEL path, CLIP, existing LoRAs
Found by walking each recipe's API graph (`prompt`, or `providers.comfycloud.options.graph` / `.text.options.graph`) [read].

**Local ComfyUI recipes (`prompt`, mode local):**
| recipe | MODEL source | path to the sampler | CLIP → text encoder | LoRA in graph | Settings rows used |
|---|---|---|---|---|---|
| flux2_klein_local | `unet` UNETLoader | unet → guider:CFGGuider | `clip` CLIPLoader(type flux2) → pos/neg CLIPTextEncode | none | 6 (1-6) |
| flux3_klein_local | `unet` UNETLoader | unet → sched:BasicScheduler **and** unet → guider:CFGGuider (two consumers) | `clip` CLIPLoader(flux3) → pos/neg; `up_clip` CLIPLoader → up_run:TextGenerate (the upsampler) | none | **8 (full)** |
| moss_image_local | `unet` UNETLoader | unet → slg:SkipLayerGuidanceDiTSimple → ks:KSampler | `clip` CLIPLoader(moss_image) → pos/neg | none | **8 (full)**; `edit:false` |
| qwen_image_edit_2_1_local | `unet` UNETLoader | unet → cache:QwenImage21Cache → run:KSampler | CLIPLoader(qwen_image) → TextEncodeQwenImage21 | none | 6 |
| qwen_image_edit_2_1_turbo_local | same as above | same | same | none | 6 |
| relight_qwen_local (task relight) | `unet` UNETLoader | unet → lora_relight → lora_lightning (both LoraLoaderModelOnly) → ModelSamplingAuraFlow → CFGNorm → KSampler | CLIPLoader → 2× TextEncodeQwenImageEditPlus | Relight LoRA + Lightning 4-step | row 4 `{node:"lora_relight", input:"strength_model", label:"Relight LoRA strength"}` |
| realism_pass, rtx_vsr_local, upscale_model_local | no MODEL (UpscaleModelLoader outputs UPSCALE_MODEL) | n/a | n/a | n/a | n/a |
No shipped local recipe uses CheckpointLoaderSimple or GGUF; every CLIP comes from a separate CLIPLoader with an LLM encoder [read].

**Relight is special** [read]: the relight route copies `relight_qwen_local.prompt` and writes `lora_relight.inputs.strength_model = loraPercent(p.lora_strength)/100` from the relight panel (host.js:3721-3741, default `lora_strength: 100` at host.js:229). It does not go through queueGenerate. select_recipe refuses relight recipes (commands.js:895). So the recipe's own row 4 is probably not what drives the strength [inferred].

**Comfy Cloud graphs** (kind provider, `providers.comfycloud.options.graph`; the variants have `settings: []` except relight.json) [read]:
- One UNETLoader, straight to the sampler, no LoRA: cloud_anima_preview, cloud_flux2_klein_9b (also its text graph), cloud_flux2_klein_9b_multi, cloud_mage_flow, cloud_mage_flow_edit_turbo.
- One UNETLoader with model patches in between: cloud_z_image_turbo (ModelSamplingAuraFlow), cloud_boogu_image_edit (UNET → ModelSamplingAuraFlow → BasicScheduler, and UNET → SamplerCustom directly), cloud_qwen_image_2_1_edit (QwenImage21Cache).
- A LoRA behind a ComfySwitchNode, where the UNET feeds both the LoRA (on_true) and the switch's on_false:
  - cloud_anima_base: anima-turbo-lora, switch 90:84;
  - cloud_flux2_dev: Flux_2-Turbo-LoRA, switch 68:92;
  - cloud_krea_2_turbo: krea2_darkbrush at 0.8, switch 30:22;
  - cloud_qwen_image_edit_2509: Lightning 4-step, switch 433:440, then ModelSamplingAuraFlow and CFGNorm.
- **Two MODEL sources**: cloud_ideogram_4. The 98:23 UNET goes through CFGOverride into DualModelGuider.model; the 98:154 unconditional UNET goes into DualModelGuider.model_negative.
- relight.json: 10:37 UNET → 10:89 Lightning → 10:118 Relight → AuraFlow → CFGNorm → KSampler. Its settings use `key` rows: `{"key":"10:118|strength_model","label":"Relight LoRA strength","spec":["FLOAT",{default 1,min 0,max 2,step 0.05}]}`. The relight route sends that key as `loraPercent(...)/100` (host.js:3786).

**ComfyUI facts** [read]:
- LoraLoader: model, clip, lora_name, strength_model, strength_clip, strengths -100..100 step 0.01 (nodes.py:714-758).
- LoraLoaderModelOnly: model, lora_name, strength_model (nodes.py:761-775).
- v0.42.4 also loads nodes_lora_stack.py (nodes.py:2469) with `LoadLoraModel`, a dynamic group `loras` of up to 20 rows (comfy_extras/nodes_lora_stack.py:26-58). Its prompt keys are `loras.<i>.<field>`, which _io.py calls an "Internal, unstable widget template" (comfy_api/latest/_io.py:1338-1341). So a chain of LoraLoaderModelOnly nodes is the stable choice.
- Model patch nodes clone the ModelPatcher and only set model_options (QwenImage21Cache at comfy_extras/nodes_qwen.py:207-210). A LoRA inserted right after the loader therefore keeps every later patch [inferred].

## 2. How a recipe is filled and queued (anchors) [read]
- `host.queueGenerate(editor, opts)` is at host.js:3944. Steps in order:
  - refusals; `missing = r.needs ∖ objectInfo` (host.js:3992);
  - `const prompt = JSON.parse(JSON.stringify(r.prompt))` (4088);
  - `trimSlots` (4092) and canvas inputs plus `canvas_state` (4093);
  - `missingFilesRefusal` (4102-4105);
  - the Settings write `for (const s of r.settings) node.inputs[s.input] = editor.settings[String(s.index)].value` (4107-4111);
  - the factor (4112-4115), `wireBoxPrompt` (4118), `wireUpsampler` (4122-4131);
  - `api.queuePrompt(0, { output: prompt, workflow: this.workflowInfo() })` (4142);
  - `kleinRun(r, prompt)` (4147, finds the UNETLoader / CLIPLoader by class) and `trackRun(..., runNodeCount(prompt))` (4170).
  - **The LoRA splice belongs between 4131 and 4142**, on the copy `prompt`.
- The upsampler precedent `comfyprompt.wireUpsampler(prompt, r, o)` (comfyprompt.js:294-331) [read]:
  - it is a declared graph change, validated at load by `recipes.js localUpsampler` (recipes.js:542-569);
  - it rewires every consumer of a node id to another link and deletes nodes;
  - it is pure and app-only: comfyprompt.js is not in build_node.py FILES (build_node.py:39-46), and tools/comfyprompt_test.js imports it.
- `withSpecDefaults(nodes)` (inpaint_canvas.js:1046-1065) fills a helper prompt's left-out required widget inputs from `host.nodeTypes()`. It sits in the editor (it ships to the node) and is used for helper prompts only, not for recipes [read].
- Object info [read]:
  - `host.loadObjectInfo()` (host.js:1287-1295) reads `/object_info` once, on connect (`onConnected`, host.js:1360). It keeps `host.objectInfo` and `host._types` (`nodeTypes()`, host.js:1283).
  - A single-node re-read precedent: `boxPromptSlot` fetches `/object_info/InpaintCanvas` and merges it in (host.js:1302-1319).
  - LoRA combo precedent: `checkComfyRelightModels` reads `info.LoraLoaderModelOnly?.input?.required?.lora_name?.[0]` (host.js:1597).
  - ComfyUI also serves `GET /models/loras` (server.py:413-419) and `/object_info` output types `info['output'] = RETURN_TYPES` (server.py:849). With these, "this node outputs MODEL" can be decided generically.
- Settings rows: `host.settingTargets` (host.js:1683-1729) takes each row's spec from `objectInfo[class].input` (1709-1711) and keys it `${r.id}/${s.node}:${s.input}`. So a row on `lora_name` already renders as a combo of the server's LoRAs (settingKind, inpaint_canvas.js:24083-24094) and counts as a file combo for presets (RECIPES.md:281-284). `missingSettingFiles` / `missingFilesRefusal` (host.js:1564-1626) refuse a combo value the server lacks (issue #4).
- recipes.js:
  - `normalize` (591-660) validates `boxes` and `upsampler`; a `loras` declaration would go the same way.
  - `GRAPH_KEEPS` (1067) lists what Save to recipe keeps from the base recipe; a new `loras` field must be added there.
  - Import: `fromWorkflow` (775-988) flattens subgraphs (ids like `57:12`) and turns inputs wired to `setting_n` into rows. `fromPrompt` (1021-1065) does the same for an API prompt.
  - `tailOutputs` (225-244) remaps the box_prompt / elements tail outputs.
  - `toPrompt` (998-1011) wires each row to `[canvas, 13+index-1]`.
  - The index cap 1..8 is documented (RECIPES.md:330-332) but not validated in toPrompt.

## 3. UI places [read]
- Generate pane: `buildSettings` creates `ed.settingsList` (inpaint_modal.js:1083-1089). `renderSettings` (inpaint_canvas.js:24122-24175) calls `host.renderPresets(this, list, targets)` (host.js:1497) first, then one row per target through `selectInput` / `numberInput`.
- `host.buildGenerateExtras(ed, sec)` (host.js:4254; called at inpaint_modal.js:1078) is the other app-only hook. The node's js/host.js answers both as no-ops (custom_nodes/ComfyUI-InpaintCanvas/js/host.js:113-114), and `build_node.py --check` fails when the editor calls a host member that either host lacks (build_node.py:106-124, 163).
- The 580-entry LoRA list needs a filterable picker; the existing `selectInput` combo has no search [inferred].
- Settings › Recipes: `renderRecipeList` (shell.js:651-750); import at shell.js:755-774.
- The existing way a user adds a LoRA today: *Edit in ComfyUI* → add a Load LoRA node → *Save to recipe* (MANUAL.md:173; toPrompt / fromGraph, recipes.js:998, 1077). To get a picker row, wire a `setting_n` output into lora_name. That only fits where a slot is free: qwen_image_edit_2_1_local has 2, MOSS and FLUX 3 Klein have none [inferred from the slot counts].
- MCP commands (renderer/commands.js) [read]:
  - `list_recipes` (853-887); `select_recipe` (889-900);
  - `set_generation` (1220-1239: mode, seed, seed_random, denoise, refine, boxes; doc-scoped);
  - `set_settings` (1273-1289, by index or label); `list_settings` (1291-1306, combos with max_options); `apply_preset` (1307-1330).
  - A `loras` parameter needs: a doc-scoped setter (on set_generation or a new set_loras), validated against the server's lora_name combo; a list (new list_loras with filter / max, like list_settings); `loras: bool` plus a reason on list_recipes; ideally `loras_sent` on generate.
  - A new command also needs an assistant policy entry (assistant/policy.js:13-17 READS, :59 AUTO), a heading in docs/COMMANDS.md (tools/mcpb_test.js:45 checks the tool count against it), and the counts in README.md:83/303 and MCP.md:306 (116 today).

## 4. API providers [read]
- No adapter sends LoRAs: a grep finds only a comment in fal.js:6 mentioning "flux-lora-fill".
- A variant declares `settings [{index,key,label,spec}]`, `fixed`, `fields`, `options` (recipes.js:616-660). `host.providerParams` (host.js:1742-1755) builds scalar params, and fal copies them into the body by name (fal.js:101-108). Replicate builds its input in replicate.js:58ff.
- fal's LoRA endpoints take a non-scalar list of URLs or HF repo ids, not ComfyUI file names:
  - `fal-ai/flux-2/klein/9b/edit/lora`: `loras: [{path, scale 0..4}]`, at most 3, `image_urls` at most 4 (https://fal.ai/models/fal-ai/flux-2/klein/9b/edit/lora/api);
  - `fal-ai/qwen-image-edit-2509-lora`: `loras: [{path, scale}]`, at most 3 (https://fal.ai/models/fal-ai/qwen-image-edit-2509-lora/api).
  - So API LoRAs need their own list type (an array param) and a URL picker [inferred].
- Replicate and WaveSpeed LoRA shapes: [unverified].
- Comfy Cloud: the splice point would be main's `buildDetached` (comfycloud.js:394-430), right after the params loop (424-429).
  - Comfy Cloud resolves the user's own imported LoRAs, which its node list does not name; a missing file there does not stop a run (RECIPES.md:416-420, comfycloud.js:268-275).
  - So a cloud picker cannot use object_info; its source is [unverified] (an assets API?).

## 5. Persistence [read]
- `editor.settings` is index-keyed and part of `getValue` (inpaint_canvas.js:24499, 24582); `settingsChanged` deletes keys whose target is gone (24097-24120). It is unsuitable for a LoRA list.
- Per recipe, app-wide (no document change): `settings.recipePresets` is the precedent (`host.savePresets` host.js:1459-1461, loaded at shell.js:3266, "shared by all documents" RECIPES.md:288). settings.js merges only the top level (settings.js:89-112), so a `recipeLoras` object is written whole.
- Per document: put it inside `gen`. Unknown keys inside `gen` / `settings` survive older apps, with no FEATURES row and no version raise (DOCUMENTS.md:171, 317-319; precedents gen.boxes and gen.target).
  - Caveat: `gen` also goes into the canvas_state the node reads (serializeForPrompt, inpaint_canvas.js:24865-24873).
  - History snapshots restore `doc.gen` (inpaint_canvas.js:14576).
  - Because LoRAs are tied to the model's architecture, a document list should be keyed by recipe id [inferred].
- Metadata gap: `workflowInfo()` (host.js:4243) describes `r.prompt`, not the queued prompt. Spliced LoRAs would be missing from the PNG tEXt chunk and the run's extra_pnginfo unless it changes [read/inferred].

## 6. Tests and tier [read]
- Plain Node:
  - tools/comfyprompt_test.js (pure graph functions over the shipped recipes, "the recipe's own graph untouched" pattern): the splice on all 5 local edit/generate recipes plus the cloud graphs, rewiring of every consumer, refusal on 0 or 2 sources;
  - tools/recipes_test.js: normalize of a `loras` declaration, GRAPH_KEEPS through fromGraph (section 5/6), cloud copy (section 7).
- Gate step: tools/boxes_test.py:751-759 is the precedent for capturing the queued local prompt. It swaps `api.queuePrompt` and `host.objectInfo` and runs flux3_klein_local; do the same for one LoRA run, a missing-file refusal and Generate new on MOSS.
- Also: commands_test.py / the mcp gate, tools/mcpb_test.js, the assistant policy test, `python tools/build_node.py --check`.
- Tier by CLAUDE.md: normal (a feature, tiles backend plus the touched gates).
  - If the list goes into the `.scumble` document, its round trip falls under Full (".scumble format").
  - Live: one run per family on the user's ComfyUI (production: check /queue, only on the user's word). Matching folders exist in models/loras: klein/, qwen/, z_image/, Flux_3/, flux_2/.

## Splice rule for "pick LoRAs for any local recipe" (proposal [inferred], each step checked against the graphs above)
1. Work on the queued copy, after Settings, boxes and upsampler (host.js 4131 → 4142). Skip `task` upscale, pass and relight (relight builds its own graph at host.js:3721).
2. Live nodes are the nodes reachable backwards from `resultOf(r)` (comfyprompt.js:28) and the output nodes; this follows the `liveNodes` idea in comfycloud.js:290-302. Upsampler nodes are never targets: `r.upsampler.nodes` holds only CLIP and TextGenerate.
3. The MODEL source is a live node whose class's object_info `output` holds "MODEL" at slot s and whose class declares no MODEL-typed input. That excludes LoraLoaderModelOnly, ModelSamplingAuraFlow, CFGNorm, QwenImage21Cache, SkipLayerGuidanceDiTSimple, CFGOverride and switches. Without object_info, fall back to class names: UNETLoader 0, CheckpointLoaderSimple 0, UnetLoaderGGUF 0.
4. With exactly one source: add nodes `scumble_lora_1..n` (LoraLoaderModelOnly), the first taking `model: [src, s]` and each next one the previous. Then rewrite every input anywhere that equals `[src, s]` to `[last, 0]`. That covers multiple consumers (flux3_klein sched + guider), switch branches, and recipe LoRAs downstream (relight: user LoRAs land before Relight / Lightning; LoRA weight deltas add, so order does not matter [inferred]).
5. CLIP: if the source also emits CLIP (a checkpoint at slot 1) whose consumers are text encoders, use a LoraLoader chain and rewire the CLIP consumers to `[last, 1]`. Otherwise use model-only; every shipped local recipe is model-only.
6. With zero sources the recipe takes no LoRAs (hide the UI, say why). With two or more, refuse unless the recipe declares `"loras": { "model": "<id>" }` or `false` (validated in normalize, kept in GRAPH_KEEPS). Shipped, only cloud_ideogram_4 has two.
7. Before queueing, refuse names the server's `LoraLoaderModelOnly.lora_name` combo lacks, with the same sentence shape as missingFilesRefusal. Re-read `/object_info/LoraLoaderModelOnly` (or `/models/loras`) when the list is stale.
8. Fresh node ids must not collide with recipe ids. Ids like `57:12` already occur in flattened imports.

**Failure cases**:
- **Wrong base model is silent.** "lora key not loaded" (comfy/lora.py:102) and "SHAPE MISMATCH ... WEIGHT NOT MERGED" (comfy/lora.py:536) are only log warnings, so the run succeeds without the LoRA. The user has 580 LoRAs, mostly SDXL by name.
- **Path separators.** ComfyUI lists relative paths with os.sep (folder_paths.py:429, relpath), e.g. `qwen\NYC_Qwen.safetensors` on Windows versus `/` on a Linux RunPod. A list stored on one server fails ComfyUI's validation on the other (the same issue comfycloud handles, RECIPES.md:421-422).
- **Stale list.** object_info is read only at connect.
- **Quantized models.** LoRA on int8_convrot / quantized weights (the shipped Qwen 2.1, FLUX 3 Klein and MOSS files) goes through QuantizedTensor paths (comfy/model_patcher.py:988, 1751; bypass adapters for quantized models in comfy/weight_adapter/base.py:73-133, and debug-only bypass loaders in comfy_extras/nodes_lora_debug.py). Whether a plain LoraLoaderModelOnly applies correctly there is [unverified]: it needs a live run.
- **Nunchaku models** need their own loader (custom_nodes/ComfyUI-nunchaku/nodes/lora/flux.py:22), so the generic splice is wrong for them; a declared opt-out is needed.
- **GGUF** works with the built-in loader, "experimental" (custom_nodes/ComfyUI-GGUF/README.md:36).
- **Speed LoRAs.** Recipe LoRAs (Lightning, Turbo) stay active, so a user LoRA trained without them may weaken [inferred].
- **No Settings rows.** The 8-slot cap means LoRA strength can't be a Settings row on MOSS or FLUX 3 Klein.
- **Metadata.** PNG / extra_pnginfo omit the spliced LoRAs (workflowInfo, host.js:4243).
- **Node build.** The editor must not call a host member the node lacks (build_node.py --check).
- **Comfy Cloud.** The LoRA must be in the user's account and the picker source is unknown.
- **MOSS edit.** moss_image_local is `edit:false`, and Generate on a selection is refused (host.js:3959). "MOSS Image Edit" (#11) is a new model recipe, separate from LoRA support.

## Facts

- [read] Settings rows are limited to slots 1..8; flux3_klein_local and moss_image_local already use all 8, qwen_image_edit_2_1_local and flux2_klein_local use 6 (docs/RECIPES.md:330-332; electron/main/recipes.js:198; recipes/flux3_klein_local.json settings; recipes/moss_image_local.json settings)
- [read] toPrompt wires each Settings row to canvas slot 13+index-1 without checking index<=8, so a 9th row would point at the box_prompt tail slot (electron/main/recipes.js:1007-1010, 197-217)
- [read] queueGenerate copies r.prompt, writes Settings rows, wires boxes and the upsampler, then queues; the LoRA splice point is between host.js:4131 and 4142 (renderer/editor/host.js:4088, 4107-4111, 4118, 4122-4131, 4142)
- [read] wireUpsampler is the precedent for a declared run-time graph change: it rewires all consumers of a node id and deletes nodes on the queued copy; validated at load by recipes.js localUpsampler (renderer/editor/comfyprompt.js:294-331; electron/main/recipes.js:542-569)
- [read] comfyprompt.js is app-only (not in the node build), pure, and tested by tools/comfyprompt_test.js (renderer/editor/comfyprompt.js:10-11; tools/build_node.py:39-46; tools/comfyprompt_test.js:1-14)
- [read] Every shipped local edit/generate recipe (flux2_klein_local, flux3_klein_local, moss_image_local, qwen_image_edit_2_1_local, qwen_image_edit_2_1_turbo_local) has exactly one UNETLoader and a separate CLIPLoader; none has a LoRA node (recipes/*.json prompt graphs (scratchpad iss_lora_app/model_tree.txt))
- [read] flux3_klein_local's UNETLoader output feeds two consumers: BasicScheduler.model and CFGGuider.model (recipes/flux3_klein_local.json (nodes unet, sched, guider))
- [read] relight_qwen_local chains UNETLoader -> LoraLoaderModelOnly(Relight) -> LoraLoaderModelOnly(Lightning 4-step) -> ModelSamplingAuraFlow -> CFGNorm -> KSampler, with Settings row 4 on lora_relight.strength_model (recipes/relight_qwen_local.json)
- [read] The relight route builds its own graph from relight_qwen_local and sets lora_relight strength from the panel's percent value / 100, not through queueGenerate (renderer/editor/host.js:229, 3721-3741)
- [read] Comfy Cloud graphs cloud_anima_base, cloud_flux2_dev, cloud_krea_2_turbo and cloud_qwen_image_edit_2509 hold a LoRA behind a ComfySwitchNode whose on_false is the bare UNET; relight.json chains Lightning and Relight LoRAs with a settings key 10:118|strength_model (recipes/cloud_*.json, recipes/relight.json (providers.comfycloud.options.graph))
- [read] cloud_ideogram_4 is the only shipped graph with two MODEL sources (conditional UNET via CFGOverride into DualModelGuider.model, unconditional UNET into model_negative) (recipes/cloud_ideogram_4.json nodes 98:23, 98:154, 98:155, 98:157)
- [read] realism_pass, rtx_vsr_local and upscale_model_local have no MODEL-producing loader (recipes/realism_pass.json, rtx_vsr_local.json, upscale_model_local.json)
- [read] LoraLoaderModelOnly takes model, lora_name (loras folder list), strength_model -100..100 step 0.01; LoraLoader also takes clip and strength_clip (F:/Comfyui/.../ComfyUI/nodes.py:714-775)
- [read] ComfyUI v0.42.4 ships LoadLoraModel with a dynamic group of up to 20 LoRA rows, whose prompt keys loras.<i>.<field> are documented as an internal, unstable template (ComfyUI/comfy_extras/nodes_lora_stack.py:26-58; nodes.py:2469; comfy_api/latest/_io.py:1338-1341)
- [read] object_info reports each class's output types (RETURN_TYPES), enabling a generic 'has a MODEL output' test; UNETLoader returns (MODEL,) (ComfyUI/server.py:849; nodes.py:992-998)
- [read] A LoRA with keys for another architecture only produces log warnings ('lora key not loaded', 'SHAPE MISMATCH ... NOT MERGED'); the run continues (ComfyUI/comfy/lora.py:102, 536)
- [read] The user's models/loras folder holds 580 entries, mostly SDXL by name, with architecture subfolders (flux, flux_2, Flux_3, klein, qwen, z_image, ...) (directory listing of F:/Comfyui/.../ComfyUI/models/loras)
- [read] ComfyUI lists model files as os.path.relpath paths, so subfolder names carry backslashes on Windows (ComfyUI/folder_paths.py:429)
- [read] ComfyUI serves GET /models/{folder} with the folder's file list (ComfyUI/server.py:413-419)
- [read] host.loadObjectInfo reads /object_info once on connect; boxPromptSlot shows a single-node re-read via /object_info/InpaintCanvas (renderer/editor/host.js:1287-1295, 1302-1319, 1360)
- [read] settingTargets takes each row's spec from objectInfo, so a lora_name row renders as a combo of the server's LoRAs; missingFilesRefusal refuses a combo value the server lacks (renderer/editor/host.js:1704-1727, 1564-1626; renderer/editor/inpaint_canvas.js:24083-24094)
- [read] The Settings section renders through renderSettings, which first calls host.renderPresets; host.buildGenerateExtras is another app-only hook; the node's js/host.js answers both as no-ops (renderer/editor/inpaint_canvas.js:24122-24175; renderer/editor/inpaint_modal.js:1078, 1083-1089; renderer/editor/host.js:1497, 4254; ComfyUI-InpaintCanvas/js/host.js:113-114)
- [read] build_node.py --check fails when the editor calls a host member either host lacks (tools/build_node.py:106-124, 163-170; CLAUDE.md 'How the app is put together')
- [read] editor.settings is index-keyed, saved in getValue, and pruned of targets the current recipe lacks (renderer/editor/inpaint_canvas.js:2198, 24097-24120, 24499, 24582)
- [read] Recipe presets are stored app-wide per recipe id in settings.recipePresets, shared by all documents (renderer/editor/host.js:1449-1461; renderer/shell.js:3266; docs/RECIPES.md:281-288)
- [read] Unknown keys inside gen/settings survive in .scumble without a version raise (precedent gen.boxes, gen.target) (docs/DOCUMENTS.md:171, 315-319)
- [read] settings.js get() merges only the top level of settings.json (electron/main/settings.js:89-118)
- [read] workflowInfo describes r.prompt (the recipe's stored graph), not the queued prompt (renderer/editor/host.js:4243-4246, 4142)
- [read] Imported workflows are flattened (inner ids instance:inner) and inputs wired to setting_n become Settings rows (electron/main/recipes.js:775-988; docs/RECIPES.md:306-332)
- [read] Save to recipe keeps only the fields in GRAPH_KEEPS from the base recipe (electron/main/recipes.js:1067, 1077-1121)
- [read] MCP set_generation (doc-scoped), set_settings / list_settings (by index), list_recipes, select_recipe are in renderer/commands.js; the assistant policy lists them (renderer/commands.js:853-900, 1220-1306; electron/main/assistant/policy.js:13-17, 59)
- [read] The mcpb test checks the tool count against docs/COMMANDS.md headings; README and MCP.md state 116 tools (tools/mcpb_test.js:45; README.md:83, 303; docs/MCP.md:306)
- [read] No provider adapter sends LoRAs today; fal passes recipe settings into the body by name as scalars (grep electron/main/providers/*.js (only fal.js:6 comment); electron/main/providers/fal.js:101-108; renderer/editor/host.js:1742-1755)
- [read] fal-ai/flux-2/klein/9b/edit/lora and fal-ai/qwen-image-edit-2509-lora take loras: [{path, scale}] (max 3), path a URL or HF repo id (https://fal.ai/models/fal-ai/flux-2/klein/9b/edit/lora/api; https://fal.ai/models/fal-ai/qwen-image-edit-2509-lora/api)
- [read] Comfy Cloud graph runs fill values in main's buildDetached; Comfy Cloud resolves the user's own imported LoRAs that its node list does not name, so a missing file there does not stop a run (electron/main/providers/comfycloud.js:268-275, 394-430; docs/RECIPES.md:416-420)
- [read] ComfyUI-GGUF says LoRAs work with the built-in loader (experimental); nunchaku has its own LoRA loader node (ComfyUI/custom_nodes/ComfyUI-GGUF/README.md:36; custom_nodes/ComfyUI-nunchaku/nodes/lora/flux.py:22)
- [unverified] Whether a plain LoraLoaderModelOnly applies correctly to the shipped int8_convrot quantized models is not established (ComfyUI/comfy/model_patcher.py:988, 1751; comfy/weight_adapter/base.py:73-133 (quantized paths exist))
- [inferred] Inserting the LoRA chain right after the loader keeps every later model patch, since patch nodes clone the ModelPatcher and set model_options (ComfyUI/comfy_extras/nodes_qwen.py:207-210; nodes.py:740-758)
- [read] The gate precedent for capturing a queued local prompt swaps api.queuePrompt and host.objectInfo in the editor (tools/boxes_test.py:751-759; tools/upscale_test.py:337-347)
- [read] moss_image_local is edit:false; Generate on a selection is refused (recipes/moss_image_local.json:8; renderer/editor/host.js:3959)
- [read] The user's ComfyUI was not running during this read (no /object_info read live) (curl to 127.0.0.1:8188 returned no connection (000))
- [read] Issue #10 asks for LoRA support for local runs (qwen 2.1, moss); #11 asks for MOSS Image Edit and editing models with LoRAs; the owner replied LoRAs go through recipes today (https://github.com/DenRakEiw/scumble/issues/10; https://github.com/DenRakEiw/scumble/issues/11 (gh issue view))

## Open questions

- Where should the LoRA list live: per recipe app-wide in settings.json (like recipePresets, no format change), or per document inside gen keyed by recipe id (survives as an unknown key, but the .scumble round trip then falls under the Full test tier)?
- Model-only (LoraLoaderModelOnly) for every recipe, or LoraLoader (model+clip) when the model comes from a checkpoint loader in a user's imported recipe?
- Should a recipe be able to declare `loras` (false, or { model: id }) for graphs with two MODEL sources (Ideogram 4 style, Wan high/low) or loaders with their own LoRA node (nunchaku)?
- Do LoRAs apply correctly to the shipped int8_convrot quantized models (Qwen Image 2.1, FLUX 3 Klein, MOSS)? This needs a live run on the user's ComfyUI, which only happens on the user's word.
- Is Comfy Cloud in scope (splice in main's buildDetached; the LoRAs live in the user's account and Comfy Cloud's node list doesn't name them; the picker source is unknown)?
- Are API LoRAs in scope (fal's */lora endpoints take loras:[{path URL or HF id, scale}], max 3)? That needs a URL list and a non-scalar param, a different design from the ComfyUI file picker.
- How should the picker handle 580 mostly-SDXL LoRAs: folder grouping, search, filtering by architecture? Scumble has no base-model metadata, and a wrong-base LoRA fails silently.
- Should the history entry, the via line and the PNG metadata (workflowInfo uses r.prompt) list the LoRAs a run used?
- Cross-server path separators (Windows backslash vs Linux slash in lora_name): normalize names when matching the server's list?
- MOSS Image Edit (#11) is a separate new-recipe task: is the model and its ComfyUI node available? Not checked here.
