# LoRAs on your ComfyUI and Comfy Cloud, and MOSS Image Edit: the build plan (item 50; issues #10 and #11)

**Status: planned 2026-11-06 against `a86b94e` (branch `corridorkey`, cut from `main` = 0.1.51 at `2d9a353`), from the
research of the same day (three read-only readers: Scumble's splice point and recipes, ComfyUI's LoRA ecosystem, what
"MOSS Image Edit" is) and the user's seven decisions. Nothing built.** Every line number is from the worktree
`.claude/worktrees/corridorkey` at `a86b94e` (the research took its anchors on `wasm-kernels`; every one cited here was
read again on this branch: `host.js`, `recipes.js`, `comfycloud.js`, `commands.js`, `shell.js` and `settings.js` are the
same lines, `inpaint_canvas.js` is not: `renderSettings` 23953, `settingKind` 23914, `withSpecDefaults` 1043). Grep the
name before editing. Facts are **read** unless marked **inferred** or **unverified**; every effort figure is inferred.
This plan may name other products, packs and model hosts (the rule of 2026-09-29 covers CLAUDE.md, the posts, the
CHANGELOG, the manual and the README). **Revised the same evening after two critics** (feasibility and rules; every
finding's evidence read again in the worktree): the Cloud splice moved out of `buildDetached`, Generate new on a Cloud
recipe carries the rows, the section sits after Settings by a DOM move, the header answer is reduced in main, FLUX.1 and
FLUX.2 are told apart, `loras` on a Cloud recipe is a variant field, §6 holds the user's calls alone; **and the user's
ComfyUI folder was re-read: it is at v0.44.0 already** (§0 decision 7's note, §2.2, §3.7).

## 0. The record

**The issues (data, read with `gh issue view` on 2026-11-06):** #10, hwatik, 2026-10-24: "Please add lora support for
local generations ... qwen 2.1 or moss"; #11, nadergits, 2026-10-31: "add moss image edit and the option to edit with
any other editing models with loras". The owner answered each once (LoRAs go through recipes today: *Edit in ComfyUI*,
a Load LoRA node, *Save to recipe*; `docs/MANUAL.md:173`). Both are open.

**The user's decisions (2026-11-06; binding):**

1. **LoRAs only for the user's own ComfyUI (local or remote) and for Comfy Cloud, never for API providers:** no fal /
   Replicate / WaveSpeed LoRA URLs.
2. **The recipes stay as they are.** Scumble splices the switched-on LoRAs into the queued copy of the graph at run
   time as a chain of `LoraLoaderModelOnly` nodes (the `wireUpsampler` precedent, `renderer/editor/comfyprompt.js:294`),
   never bypassed placeholder nodes in the recipe file (API format has no bypass, and a placeholder's `lora_name` would
   have to exist on the server).
3. **Up to five LoRAs per recipe:** rows with a LoRA picker (the server's list, with search), a strength, an on / off
   switch per row, and a **+** that adds a row; a switched-off row is not sent.
4. **Stored per recipe** (a LoRA fits only its base model).
5. **The base model and the trigger words shown where the file allows** ("das wäre super").
6. **Released together with CorridorKey 2.0 in 0.1.52** on the branch `corridorkey`.
7. **The ComfyUI update:** Claude updates the user's ComfyUI from v0.42.4 to v0.44.0 (or the newest stable at the time)
   with a backup as on 2026-10-22 (ComfyUI's own update script with its backup branch, a pip freeze kept), the changed
   package pins shown to the user before anything is installed into the production Python, only while ComfyUI is stopped
   or its queue is empty, never while a benchmark runs on the machine; then the local MOSS Image Edit recipe and its live
   run. A session of its own (LR8), before the MOSS edit recipe's live run.
   **Read 2026-11-06 evening, after the research:** the folder is **at v0.44.0 already** (`comfyui_version.py` 0.44.0;
   `git log -1` in `ComfyUI/`: `2c75dc1b3 ComfyUI v0.44.0` = the tag `v0.44.0`; a backup branch
   `backup_branch_2026-11-06_02_55_11`; `ComfyUI/requirements.txt` and `update/current_requirements.txt` both at frontend
   1.57.6, templates 0.11.101, embedded-docs 0.5.16, comfy-aimdo 0.6.0, comfy-kitchen 0.2.40; `TextEncodeMOSSImageEdit`
   at `comfy_extras/nodes_moss_image.py:102`; the edit LoRA still absent from `models/loras`; the server was not
   running, so `/system_stats` is unread; no commit on any branch of this repository records that run). So the update
   decision 7 asks for **has been carried out**: by the planning session itself, on the user's "ok, update" after the
   pins were shown (2026-11-06 02:55; `update.py --stable`; the pip freeze before it in that session's scratchpad
   `comfy_update/pip_freeze_before.txt`; ComfyUI then started once with the user's `run_nvidia_gpu.bat` flags: 5,904
   node classes, `TextEncodeMOSSImageEdit`, InpaintCanvas with 23 outputs, RTX VSR, the DLSS5 nodes and `SAM3Segment`
   loaded, the same three IMPORT FAILED as on v0.42.4 and v0.41.2 (`dlss` and `inpaint` without `__init__.py`,
   `comfyui-tosvg` without `vtracer`), and stopped again). **LR8 keeps its shape only for a server below the target at
   its start** (a newer stable may be out by then, the user's call), **else it is the checks, the LoRA download and the
   record** (§3.7).

**Decided by the main session (not reopened here):** the splice rule of `lora_app.md` (the single live node with a
MODEL output and no MODEL input; every consumer of that output re-pointed to the chain's end; `LoraLoader` with
`strength_clip` instead, CLIP consumers re-pointed too, when the source also outputs CLIP, as a checkpoint loader in a
user's imported recipe does; a recipe may declare `loras: false`, or name its model source where the rule finds none or
several, as `cloud_ideogram_4` would need; recipes without a MODEL output show no LoRA rows); the chain of
`LoraLoaderModelOnly` nodes, not core's `LoadLoraModel` stack (its dotted row keys are "Internal, unstable",
`comfy_api/latest/_io.py:1337-1354`); the LoRAs never through the eight Settings slots; storage per recipe in
`settings.json` beside `recipePresets` (no `.scumble` format change); a refusal before the run when a picked file is
not in the server's list (`missingFilesRefusal`'s shape, `host.js:1622`), names matched with backslash and slash
normalised; the LoRAs a run used shown in the history entry, the via line and the PNG / export metadata; **base model
detection** by tensor key prefixes when Scumble can read the file (the linked ComfyUI models folder of Settings ›
Helpers on this machine), else ComfyUI's metadata endpoint (`/view_metadata/{folder}`, it exists, §2.2) and the
subfolder name, shown as a hint ("looks like Qwen Image 2.1", "metadata says SDXL"), **never a refusal on it** (metadata
lies: the user's `anna_qwen` says `sd_1.5`); trigger words from metadata (`ss_tag_frequency`, `modelspec`) where
present, a click puts one into the prompt; the picker groups by subfolder and filters to the recipe's family when the
family is known, with a *Show all* switch; Comfy Cloud: a short probe finds whether Comfy Cloud's API lists the user's
imported LoRAs; if not, the row takes a typed file name with a note that LoRAs are imported on Comfy Cloud's site
(Creator plan or higher), and the splice runs in main (`comfycloud.js` `buildDetached`) for Cloud graphs. **MOSS Image
Edit:** a new local recipe `moss_image_edit_local` from Comfy's template `image_moss_image_edit` (core nodes only), its
`needs` naming `TextEncodeMOSSImageEdit` so a v0.42 server gets the readiness sentence, the `comfyrefs` ENCODERS entry,
the pictures' names decided by a live run, a Comfy Cloud variant from the same template; the edit LoRA is part of the
recipe graph (not one of the user's five rows), the user's rows splice after it; the licence of chinoll's weights is
unstated (Comfy-Org's card says Apache-2.0): the manual and RECIPES.md say so.

**Decided in this plan** (design choices the code could answer; §6 holds what it could not): the item number **50** in
CLAUDE.md's list (the hand-over goes into a new item 50 block and the "Where things stand" line, as item 49's rule); the
*LoRAs* section through `ed.addSection(title, open, build, "gen")` (`renderer/editor/inpaint_modal.js:368`, the hook the
Boxes plugin's panel uses), **the returned `<details>` then moved to right after the Settings section by app-only code**
(`addSection` returns the element it appended, 359-368; one `insertBefore`), so **no shipped editor file changes and no
node build** (§3.2); the LoRAs in the history entry inside the result's `via` text (the entry keeps a fixed set of
fields, `inpaint_canvas.js:18645-18650`); a declared `loras.model` may name a node that itself has a MODEL input (the
edit LoRA of the MOSS recipe), the generic rule may not; on a Cloud recipe the declaration is a **variant field**
(`providers.comfycloud.loras`, §3.5) that holds for the edit graph and the text graph alike; a Cloud request carries
`loras: { rows, declared }` from both paths that build one (`runProvider` and Generate new's own request, §3.5); a
fourth MCP change beside the three named, a read-only `list_loras` (an agent has no other way to learn the server's
names; the tool count as §3.8 rules it); the strength row offers −2 .. 2 in steps of 0.05, default 1.0, typed values
clamped to the node's own range (−100 .. 100); the relight recipes take no user rows in 0.1.52 (they never go through
`queueGenerate`, `host.js:3721-3741`; `select_recipe` refuses them, `commands.js:896`); the pictures' names in the MOSS
edit prompt are decided by LR9's run, not asked (§7).

## 1. What the user gets, and how a run changes

**The behaviour in one sentence (the say-behaviour-first rule; repeated in chat before LR1 and LR2):** *under the
Generate tab a* LoRAs *section, shown only while the selected recipe runs on your ComfyUI or Comfy Cloud and its graph
has one model loader, holds up to five rows, each a LoRA from the server's list, a strength and an on / off switch; a run
of that recipe loads the switched-on rows in their order between the recipe's model loader and whatever reads the
model, at the strengths given, in the queued copy of the graph only; the recipe file never changes, the rows are
remembered per recipe for every document, a switched-off row goes nowhere, and a row naming a file the server does not
have refuses the run before anything is uploaded.*

What a person does and sees:

1. Picks a ComfyUI recipe (FLUX 3 Image Klein, Flux.2 Klein, Qwen Image Edit 2.1, MOSS-Image, or an imported one). The
   Generate pane gains a section **LoRAs** (closed by default) after the Settings rows. Under an API recipe, an upscaler,
   the Realism Pass or a graph without a model loader the section is hidden; its summary's tooltip says why when a
   recipe declares `loras: false` or has two model sources.
2. **+** adds a row: a picker over the server's LoRA list, grouped by subfolder (`klein\`, `qwen\`, `Flux_3\` ...), the
   recipe's family group first and the rest behind *Show all*, a search field, Enter picks, Escape closes. Under the
   picked name a grey hint: "looks like FLUX 3" (read from the file's tensor keys, when Scumble can read the file),
   "metadata says SDXL" (the file's own metadata, which may lie), or "in folder klein" (the name alone). When the hint
   disagrees with the recipe's family the line turns amber: "This LoRA looks made for Qwen Image Edit 2509; this recipe
   runs Qwen Image 2.1. ComfyUI loads it without an error and the picture may come back unchanged." Nothing is refused
   on it. Trigger words the file carries show as chips; a click appends one to the prompt.
3. Each row: the on / off tick, the name (the file's stem; the full path in the tooltip), the strength (−2 .. 2, 1.0),
   **×**. Five rows at most; the sixth **+** is greyed with "five LoRAs per recipe".
4. *Generate* or *Generate new*: the status line says "LoRAs: Flux3_Targa 0.8, nyc_style 1.0." with the run's other
   notes; the result's history entry reads "FLUX 3 Image Klein via your ComfyUI + 2 LoRAs: Flux3_Targa 0.8, nyc_style
   1.0, 14 s"; an exported PNG's recipe chunk and the run's `extra_pnginfo` list them. A row naming a file the server
   lacks: "Your ComfyUI lacks a LoRA file this recipe's rows name: klein\old.safetensors. Put the file in models/loras
   (and refresh ComfyUI), pick one of the server's files in the LoRAs section, or switch the row off, then try again."
5. Comfy Cloud recipes (`cloud_qwen_image_edit_2509`, `cloud_flux2_klein_9b` ...) get the same section; the picker lists
   what Comfy Cloud's node list offers and, if the probe (LR5) finds the account's imports, those too; else a typed name
   with the note that LoRAs are imported on Comfy Cloud's site (Creator plan or higher). A name Comfy Cloud's list lacks
   does not stop a Cloud run (the account's own models are not in that list, `docs/RECIPES.md:418`). *Generate new* on
   a Cloud recipe loads the rows too (its request is built apart from an edit's, §3.5); its status note names them.
6. **MOSS Image Edit** (issue #11): a new recipe *MOSS-Image Edit (ComfyUI)* edits the selection by instruction with up
   to three more pictures, on ComfyUI 0.43 or newer; on a server below 0.43 it is listed and says "The server lacks
   these node types: TextEncodeMOSSImageEdit" (the user's folder is at 0.44.0 since 2026-11-06, §0). Its edit LoRA (297 MB, Comfy-Org's rehost) is a
   Settings row with its download link, refused with the link while missing (issue #4's mechanism); the user's own LoRA
   rows stack after it. A Comfy Cloud variant runs the same template there.
7. Agents: `set_generation loras`, `status.loras`, `list_recipes` `loras`, `list_loras`, `generate` / `generate_new`
   `loras_sent` (§3.8).

**The Inpaint Canvas node's own editor** (inside ComfyUI) gets none of this: there a LoRA is a Load LoRA node in the
graph, as before. No shipped editor file changes (§3.2), so the release carries no node build from this plan.

## 2. The facts that decide the design

### 2.1 Scumble's queue path and its hooks (read at `a86b94e`)

- `host.queueGenerate(editor, opts)` (`renderer/editor/host.js:3944`): the refusals (`edit: false` 3959, `needs` against
  `objectInfo` 3992-3993), the copy `JSON.parse(JSON.stringify(r.prompt))` 4088, `trimSlots` 4092, the canvas inputs
  4093-4101, `missingFilesRefusal` 4102-4105, the Settings write 4107-4111, the factor 4112-4115, `wireBoxPrompt` 4118,
  `wireUpsampler` 4122-4132, the pass's DLSS loop 4133-4141, `api.queuePrompt(0, { output: prompt, workflow:
  this.workflowInfo() })` 4142, `kleinRun` 4147, the log line "prompt as sent" 4163-4165, `trackRun(...,
  runNodeCount(prompt))` 4170, the click's texts with `via: viaLine(r, "your ComfyUI", null)` 4180-4189. **The splice
  goes between 4132 and 4142 on the copy; its refusal among the refusals of 3990-3994, before `ensureOnServer` (4087)
  uploads anything.**
- `onConnected` (1358-1362) sets `connected = true` even when `loadObjectInfo` failed (`catch { this.objectInfo = null;
  this._types = {}; }`), so a connected server may have no node list; `missingSettingFiles` skips a combo without options
  (`if (k.kind !== "combo" || !k.options.length) continue;`, 1576): a check against an empty list refuses nothing.
- **Two provider paths build a request:** `runProvider` (2041) builds the edit request at 2105-2112 (`options:
  shape.options`, the variant's `options` object) and lands the result with `via: viaLine(r, label, res.seconds)` at
  2133 (the upscale's own at 2319); **Generate new does not go through it:** `runGenerate` builds its own request (`kind:
  "text"`, 2586-2597) and calls `providerEdit` directly, then sets the new base (no history entry, no `via`; the status
  line and the command's answer carry its notes); the dialog's layout request at 1947 is built the same way.
- `buildDetached(req, ctx)` (`comfycloud.js:394-396`) reads `const o = req.options` (graph, pictures, mask, values,
  needs, save, workflow): a field outside `options` reaches main only on the request itself. In `run` (592-607) and
  `runV2` (752-786) `checkModelFiles(req, info)` runs on `req.options.graph` **before** `buildGraph` → `buildDetached`,
  and the separator fixes (keyed `"<node>|<input>"`) are written into the built graph afterwards; `modelFiles` (304-323)
  reads `req.options.graph` and `req.params` only. Nodes a splice adds inside `buildDetached` would be seen by none of
  them.
- `ed.addSection` **returns** the `<details>` it appended (`inpaint_modal.js:359-368`: `section()` does
  `pane.appendChild(d); return d;`); `ed.settingsList` is made inside the Settings `<details>` (`buildSettings`,
  1083-1089), so `ed.settingsList.closest("details")` is that section. Plugin panels mount on `host.on("built")`
  (`plugins.js:925-929`), which `editorBuilt` emits at the end of the editor constructor (`host.js:826-831`), before
  `addEditor` → `applyRecipe` (`shell.js:164-169`): a section made in `applyRecipe` lands after the Boxes panel unless
  it is moved.
- `comfyview:saved` carries `{ id, message }` (`main.js:1035, 1047`, two sends); the base recipe's id is `heldId` in
  `comfyview.js:509` and known in main's `saveComfyGraph` only; the shell's handler is `shell.js:3319` `onSaved(async ({
  id, message }) => ...)`.
- `viaLine(r, route, seconds)` (`host.js:237-241`) is a string; the result lands at `host.js:5407-5412` with `via:
  "<model> via your ComfyUI, N s"` and `addResults` keeps `prompt, negative, refs, seed, mode, denoise, via` of what the
  host hands it (`inpaint_canvas.js:18645-18650`), shows `via` in the status (18653) and the history row (20650,
  `.ipc-hvia`). Another field needs a shipped-file change; a longer `via` does not.
- `workflowInfo()` (`host.js:4243-4246`) describes `r.prompt` (the recipe's stored graph), not the queued copy; it is the
  export's tEXt chunk (`workflowForPng`, 4232-4235, when `embedRecipe` or the export's own switch says so) and a local
  run's `extra_pnginfo` (4142; `host.js:400`). The `metadata` gate checks `wf.app === "scumble"` and the chunk's
  presence (`tools/metadata_test.py:129`), not its other keys.
- `wireUpsampler` (`comfyprompt.js:294-331`) is the precedent: pure, on the queued copy, re-pointing every input that
  read the switch to the chosen side, deleting nodes; declared in the recipe and validated at load by `recipes.js`
  `localUpsampler` (542-563), dropped with a warning when it does not hold (`normalize`, 615-622); kept by Save to
  recipe through `GRAPH_KEEPS` (1067); taken out of the Comfy Cloud copy (`withoutUpsampler`, 571-583).
  `comfyprompt.js` is app-only (`tools/build_node.py` FILES, 39-46, lists neither it nor `comfyrefs.js` nor `host.js`).
- `resultOf(r)` (`comfyprompt.js:28`) names the result node; `comfycloud.js` `liveNodes(graph, info, save)` (290-301)
  walks backwards from the output nodes: the shape of "live" this plan uses on both sides.
- Object info: `loadObjectInfo` once on connect (`host.js:1287-1295`, `onConnected` 1358-1372); a single node re-read
  through `/object_info/InpaintCanvas` (1302-1318); the LoRA combo read as
  `info.LoraLoaderModelOnly?.input?.required?.lora_name?.[0]` (1598); `/object_info`'s `output` lists each class's
  return types (ComfyUI `server.py:849`), so "this node outputs MODEL at slot s" and "this class takes a MODEL input"
  are both readable from it.
- The Settings rows: `settingTargets` (`host.js:1684-1723`) takes the spec from `objectInfo`, keyed
  `${r.id}/${s.node}:${s.input}`; `missingSettingFiles` / `missingFilesRefusal` (1566-1582, 1622-1627) refuse a combo
  value the server lacks, with the recipe's `models` download link (`modelLink`, 1585); `presetTargets` (1452-1457)
  counts `*_name` file combos, `lora_name` among them; presets live in `settings.recipePresets` through `savePresets`
  (1459-1462, the whole object written) and are loaded at `renderer/shell.js:3266`. The slot cap 1..8 is documented
  (`docs/RECIPES.md:41-44`, 329-331) and not validated in `toPrompt` (`recipes.js:998-1012`); `flux3_klein_local` and
  `moss_image_local` use all eight (`recipes/*.json`).
- **A section in the Generate pane without a shipped change:** `ed.addSection(title, open, build, paneId)`
  (`inpaint_modal.js:368`; the panes are `image` and `gen`, 343) appends a `<details>` to the pane's end; plugin panels
  use it (`renderer/plugins.js:388-402`; the Boxes panel `plugins/boxes/main.js:221-226`, `pane: "gen"`). The sections'
  order is Prompt, Generate, Settings, History, Crop (`inpaint_modal.js:38-42`), then whatever `addSection` adds.
  `host.applyRecipe(ed)` (`host.js:1673-1681`) runs on every recipe change for every editor; `host.setRecipe`
  (1433-1437) emits `"recipe"`.
- `withSpecDefaults` (`inpaint_canvas.js:1043-1065`) fills a helper prompt's required inputs from `host.nodeTypes()`; it
  is for helper prompts, not recipes; the splice sets every input of its nodes itself.
- Commands: `list_recipes` (`renderer/commands.js:853-887`, `recipeReadiness` 411-426), `select_recipe` (889-900),
  `status` (915-925; `generation` at 343), `set_generation` (1220-1237), `set_settings` (1273-1289), `list_settings`
  (1291-1306), `generate_new`'s answers (1392, 1422), `generate` (1631-1673, `prompt_sent`, `notes`, `boxes`). The
  assistant's policy rows (`electron/main/assistant/policy.js:14-17` READS, 47-61 AUTO, 59 `set_generation`, 61
  `list_settings`); every command needs a row (`tools/assistant_test.js:681-682`); the `.mcpb` tool count is the count
  of `### ` headings in `docs/COMMANDS.md` (`tools/mcpb_test.js:45-46`); README 83 / 303 and `docs/MCP.md:306` say 116.
- Settings store: `electron/main/settings.js` `get()` merges only the top level (85-104), `set()` writes the whole
  object (106-110); `recipePresets` is not in `DEFAULTS` (10-57), it is read with `|| {}`. The migration test is
  `tools/settings_migration_test.js`.
- Comfy Cloud: `buildDetached(req, ctx)` (`electron/main/providers/comfycloud.js:394-431`) copies `o.graph`, uploads the
  pictures, writes the values (418-423) and the `"<node>|<input>"` params (424-429); `modelFiles` / `checkModelFiles`
  (304-369) read the graph's file values against `cloudInfo` (257) and fix separators, but a missing file does not stop
  the run (`missingNote`, 372-376; `docs/RECIPES.md:416-421`). The SDK's routes (`@comfyorg/sdk` 0.5.0,
  `dist/low/generated/types.gen.d.ts`) hold `/api/v2/assets` (242), `from-hash`, `by-hash`, `{id}`, `{id}/content`
  (290-438) and `/api/v2/jobs` (506): no route lists the account's models; the SDK is loaded in main by `require()` of
  an ESM package (`comfysdk.js:31-34`), Electron's `require(esm)`.
- `comfyRefSpec` (`comfyrefs.js:150-178`) builds `classes` and `batches` as Sets: two encoder nodes of one class
  reading the same `ImageFromBatch` slots (a positive and a negative) are one class and k batches, the identity holds,
  and `trim` lists both nodes' inputs for `trimSlots` (206). ENCODERS (37-62) knows `TextEncodeQwenImage21` (keys
  `images.image_k` numbered by rank), `TextEncodeQwenImageEditPlus`, `ReferenceLatent`.
- `tools/cloud_recipes.js` writes the shipped Cloud recipes from Comfy's template exports in `tools/refs/comfy_cloud/`
  (`edit/`, `t2i/`) through a MANIFEST (31-); `build` (72-90) writes the manifest's `refs`, `limits`, `sizes` into the
  variant `providers.comfycloud` and only id / kind / task / name / family / description / default / providers at the
  top; `--check` is run by `recipes_test.js`. The widget order comes from `tools/refs/comfy_templates/object_info.json`
  (93 classes; **no `TextEncodeMOSSImageEdit` and no `SkipLayerGuidanceDiTSimple`**; `MarkdownNote` is in `SKIP_TYPES`,
  `recipes.js:246`, so its absence costs nothing; `t2i/` has no MOSS template). `fromWorkflow` takes a node's
  `widgets_values_named` when the export carries them (905-915: for a class the node list lacks they stand for
  themselves, for a known class only the declared inputs go), else `readWidgets(info, values)`, which walks
  `info.input` and returns `{}` without `info` (725-744). **Every shipped export carries `widgets_values_named`, and so
  does the research's copy of `image_moss_image_edit.json`** (15 of 15 widget nodes, `frontendVersion` 1.57.1, read in
  the planning session's scratchpad): the generated graph keeps every widget of the two unknown classes. What the
  missing specs cost is the **check**: `recipes_test.js` §10 (805-870) reads `info[n.class_type]` for its required-input
  check, so an unknown class is checked for nothing, and it hard-codes "the manifest ships the thirteen".
- Gates: a gate name without a rule runs `tools/<name>_test.py` (`docs/TESTING.md:153`); a local run with
  `api.queuePrompt` and `host.objectInfo` swapped is the precedent in `tools/generate_test.py:2500-2508` (Q1 Klein) and
  2590-2597 (Q9 upsampler), `tools/boxes_test.py:751-759`, `tools/commands_test.py:853-859`.

### 2.2 ComfyUI (the user's v0.42.4 read on disk by the research; the server was not running then or at the re-read)

**The folder is at v0.44.0 since 2026-11-06 02:55** (the evening re-read, §0 decision 7's note): the node facts below are
v0.42.4's where they say so and hold on v0.44.0 unless marked; `TextEncodeMOSSImageEdit` is on disk now
(`comfy_extras/nodes_moss_image.py:102`); the edit LoRA is not; the running server's version is read at LR8 step 3.

- `LoraLoaderModelOnly` (model, lora_name, strength_model −100..100 step 0.01) and `LoraLoader` (plus clip,
  strength_clip), both chainable, a LoRA at both strengths 0 skipped (`nodes.py:714-775, 741`). Comfy's own templates
  for the DiT families use model-only; the 13 DiT LoRAs the reader opened (the user's and Hugging Face's) carry no
  text-encoder keys; SDXL LoRAs do (792 of 2,958 keys on `lora_te1_*`), so a checkpoint-loader graph wants `LoraLoader`
  (`lora_ecosystem.md` §3).
- **A wrong LoRA never fails a run:** unmapped keys log "lora key not loaded", a shape mismatch logs "ERROR" and keeps
  the weight; the picture comes back as if no LoRA were loaded (`comfy/lora.py:99-102`, `weight_adapter/lora.py:284-285`).
  Qwen Image 2.1 is another architecture than Qwen Image / Edit 2509 / 2511 (single-stream `attn.to_q`, `img_mlp.gate_up`,
  `txt_in.text_norm` against `attn.add_k_proj`; `ldm/qwen_image21/model.py:57-78`), so a 2509 LoRA does nothing on 2.1
  (inferred); Klein 4B and 9B differ in width (inferred).
- `lora_name` must match the server's list exactly (`execution.py:1060-1090`); the list is `os.path.relpath` under
  `models/loras` and the extra paths, so on Windows subfolders carry backslashes (`folder_paths.py:404-446`); the list
  follows the folder's mtime, so a new file shows without a restart (inferred). `GET /models/loras` returns it
  (`server.py:413-419`).
- **`GET /view_metadata/{folder}?filename=<name>.safetensors` exists in v0.42.4** (`server.py:749-770`): it answers the
  file's `__metadata__` object alone (the header read to 1 MB), 404 for a file without metadata or not `.safetensors`.
  **The tensor key names are not served by any endpoint**: they come only from the file itself.
- The user's `models/loras`: 1,201 `.safetensors` in all (the ecosystem reader's `find`; the app reader counted about
  580 folder entries), mostly SDXL and FLUX.1 by name, family subfolders `qwen/` 27 (the Relight and Lightning LoRAs,
  `anna_qwen`, `Qwen_Targa`, `NYC_Qwen` ...), `klein/` 25, `Flux_3/` 4 (the user's own, `Flux3_Targa`, ai-toolkit,
  `ss_base_model_version = flux3`), `z_image/` 3, `flux_2/` 2, `ideogram/` 1; one Klein LoRA sits in `kontext/`
  (folders are a hint, not a fact); `anna_qwen`'s metadata says `sd_1.5` (ai-toolkit 0.4.0): **metadata lies**.
- `custom_nodes` holds 142 entries (about 130 packs: 9 `.disabled`, 2 `.zip`, 3 stray files among them; ComfyUI-GGUF,
  ComfyUI-nunchaku, comfyui-rmbg, ComfyUI-DLSS5-Enhancer, dlss5_fit_size, Nvidia_RTX_Nodes_ComfyUI, ComfyUI-InpaintCanvas,
  ComfyUI-HotReloadHack, ComfyUI-Manager, RES4LYF, comfyui-kjnodes, ComfyUI-WanVideoWrapper, ComfyUI-LTXVideo,
  comfyui-impact-pack, was-ns, comfyui_controlnet_aux; names read 2026-11-06). GGUF loaders work with the built-in LoRA loader
  (experimental); Nunchaku models need their own loader, so the generic splice is wrong there (`lora_ecosystem.md`,
  `lora_app.md` failure cases).
- Quantised models: Scumble's local recipes load `*_int8_convrot` files; ComfyUI applies LoRA patches in the compute
  dtype when it casts a quantised weight (`comfy/ops.py:911, 1493`), and Comfy's own MOSS edit template runs a LoRA on
  `moss_image_sft_int8_convrot`: LoRAs on int8_convrot work at least there (inferred); **on the shipped Qwen 2.1 and
  FLUX 3 Klein files it is unverified** until LR9.
- The shipped `relight_qwen_local.json` hard-codes root-level `lora_name` values (`Qwen-Image-Edit-2509-Relight`,
  `...Lightning-4steps-V1.0-bf16`) that the user's files do not match (`qwen/Qwen-Edit-Relight.safetensors`,
  `...-fp32`): a `docs/BUGS.md` line (LR0 writes it; not fixed in this plan).

### 2.3 MOSS Image Edit (read 2026-11-06)

- No official OpenMOSS edit model: OpenMOSS-Team has MOSS-Image-Base and -SFT only (text to image, Apache-2.0), and
  said on 2026-10-17 it is "actively exploring reference-related features". "MOSS Image Edit" is **chinoll's community
  LoRA** (rank 64, 297,382,216 bytes, released 2026-10-22/23, up to four references, no mask; the weights' licence
  unstated on chinoll's repository, the project's code GPL-3.0), **rehosted by Comfy-Org** as
  `Comfy-Org/MOSS-Image/loras/moss_image_edit_lora_rank_64_bf16.safetensors` (2026-10-26, "same bytes"; that
  repository's card says Apache-2.0), with Comfy's template `image_moss_image_edit` ("MOSS-Image: Image Edit LoRA",
  `minComfyUIVersion 0.43.0`). Issue #11 came five days after the template: that template is what the author means
  (inferred).
- The template's graph: `UNETLoader moss_image_sft_int8_convrot` → `LoraLoaderModelOnly` (the edit LoRA, 1.0) →
  `SkipLayerGuidanceDiTSimple` (single layer 22, 0 to 1) → `KSampler` (30 steps, CFG 4, euler, normal, denoise 1);
  `CLIPLoader qwen3.5_9b_w4a8_gptq` type `moss_image`; `VAELoader flux2-vae_small`; `LoadImage` →
  `ImageScaleToTotalPixels` (lanczos, 1 MP, 16) → `GetImageSize` → `EmptyFlux2LatentImage`; two
  `TextEncodeMOSSImageEdit` (positive and negative) with `images.image_0` the scaled picture, `vae`, `edit_format
  "Moss-Image-Edit"`, `image_strength 1`. Its notes: both encoders the same `edit_format`; up to four references; about
  0.26 MP makes the model re-frame instead of edit; keep CFG at 4.
- `TextEncodeMOSSImageEdit` (core, `comfy_extras/nodes_moss_image.py:95-149` on master = v0.43.0 = v0.44.0): `clip`,
  `prompt`, optional `vae`, `edit_format` (`ai-toolkit`, `ai-toolkit (kv_cache off)`, `Moss-Image-Edit`), autogrow
  `images.image_0 ...` (0-based; Comfy Cloud's catalog shows up to ten), `image_strength` 0-100; output CONDITIONING
  with reference latents. In the `Moss-Image-Edit` format no picture enters the text (no "Picture N" markers); the
  ai-toolkit formats prefix `Picture N:`. **Not in v0.42.4** (its `nodes_moss_image.py` has `MOSSImageLayoutPrompt` and
  `MOSSImageControl` only; `MOSSImage._forward` takes no reference latents); the edit LoRA's bare keys (`layers.N.proj.q`)
  load from v0.43.0 (PR #17296). **ComfyUI v0.43.0 is of 2026-10-27, v0.44.0 of 2026-11-04.**
- v0.42.4 → v0.43.0 changes `requirements.txt`: comfy-kitchen 0.2.39 → 0.2.40, comfy-aimdo 0.5.6 → 0.6.0, the frontend
  1.55.18 → 1.57.4, the templates to 0.11.97, `Pillow>=10.1.0` new (the research's table, from GitHub's compare, which
  starts the templates at 0.11.89). **The installed files differ from that reading:** in the morning the user's
  `update/current_requirements.txt` held frontend 1.55.18, templates 0.11.94, embedded-docs 0.5.14 (the research's read);
  in the evening it and `ComfyUI/requirements.txt` hold frontend 1.57.6, templates 0.11.101, embedded-docs 0.5.16,
  comfy-aimdo 0.6.0, comfy-kitchen 0.2.40, `Pillow>=10.1.0` (v0.44.0's pins: the update ran in between, §0). **A pins
  diff shown to the user is always taken from the installed `ComfyUI/requirements.txt` against the target tag's file**,
  never from this table.
- The user's models folder has `moss_image_sft_bf16` (10.16 GB), `qwen3.5_9b_int8_convrot` and `flux2-vae_small`
  already (`recipes/moss_image_local.json` loads them); the edit LoRA is missing.
- No hosted API edits with MOSS (fal and WaveSpeed serve text to image, with LoRA variants; Replicate none found;
  `fal-ai/moss-image/edit` is a 404). **Comfy Cloud has the node, the edit LoRA, the SFT / Base / turbo models, the
  text encoders, the VAE and the template**; Comfy Router has no MOSS partner model.
- Scumble today: `recipes/moss_image_local.json` is `edit: false` (Generate new with boxes, `boxes_model.js:192-199`),
  all eight slots used; `recipes.js:602` and `host.js:3959` gate it. A separate recipe id keeps that one as it is.

### 2.4 The ComfyUI update mechanism (the portable install, read on disk)

`update/update_comfyui_stable.bat` runs `python_embeded\python.exe update.py ..\ComfyUI\ --stable` (then once more if
the script updated itself). `update.py` stashes local changes (60-64), **creates `backup_branch_<date>_<time>` at the
current head** (66-70), checks out `master` (73-90), pulls (92-93), with `--stable` checks out the newest `v*` tag
(95-112), copies a newer `update.py` into place (143-145), and **runs `pip install -r requirements.txt` whenever
`update/current_requirements.txt` differs from the repo's, then copies the new file over it** (148-152). The 2026-10-22
update to v0.42.4 went this way (CLAUDE.md: `backup_branch_2026-10-22_12_07_23`, the pip freeze in that session's
scratchpad), and so did the one of 2026-11-06 02:55 to v0.44.0 (`backup_branch_2026-11-06_02_55_11`; §0). A rollback is
`git checkout <backup branch>` in the ComfyUI folder plus the old requirements. **Three traps for a scripted run:** the
bat ends in `pause` when started without an argument (`if "%~1"=="" pause`) and uses paths relative to `update\`, so a
non-interactive run from another folder hangs or misses `..\python_embeded`; `update.py` runs pip **unconditionally**
whenever `update/current_requirements.txt` differs from the repo's file (148-152), so "the git part alone" is had only by
making the two files equal first; `--stable` takes the newest `v*` tag **at run time** (`latest_tag` over
`refs/tags/v*`, 95-112), not GitHub's `releases/latest`, which can lag a tag or lead it.

## 3. The design

### 3.1 The splice: `renderer/editor/loras.js` (new, pure, ES module, app-only)

Imported by `host.js` and `tools/loras_test.js`; **not** in `build_node.py` FILES (like `comfyprompt.js`). Four functions:

- **`modelSource(prompt, r, info)`** → `{ node, slot, clip: { slot, consumers } | null }`, or `{ none: reason }`, or
  `{ many: [ids] }`. `r.loras === false` → none ("the recipe takes no LoRAs"). `r.loras.model` → that node when it
  exists and its class outputs MODEL at slot 0 (a declared node may itself read a MODEL: the MOSS edit LoRA). Else: the
  live nodes (reachable backwards from `resultOf(r)` and every `output_node` class the node list marks, the `liveNodes`
  idea; the upsampler's `r.upsampler.nodes` excluded); among them the nodes whose class's `info[class].output` holds
  `"MODEL"` at some slot and whose `input.required` / `optional` specs name no `"MODEL"`; without `info` for a class
  (the node list unread, an unknown class), the class-name table: `UNETLoader` 0, `CheckpointLoaderSimple` 0 (CLIP at 1),
  `UnetLoaderGGUF` 0, `CheckpointLoaderGGUF`/`UnetLoaderGGUFAdvanced` 0; a class matching `/^Nunchaku/` → none ("its
  loader needs the pack's own LoRA node"). Exactly one → the source, with `clip` when the class also outputs CLIP and
  some live text-encoding node reads `[src, clipSlot]`. Zero → none ("the graph has no model loader Scumble can see");
  two or more → many. Every shipped local edit / generate recipe has one `UNETLoader` and a separate `CLIPLoader`
  (model-only), the three upscalers none, `cloud_ideogram_4` two (`98:23` through `CFGOverride` into `DualModelGuider`,
  `98:154` into `model_negative`; it declares `loras: false`, §3.5).
- **`spliceLoras(prompt, r, rows, info)`** → `{ applied: [{ name, strength }], note }`, in place on the copy: the rows
  with `on !== false`, a non-empty `name` and a finite `strength`, at most `MAX_LORAS = 5`; none → nothing changes.
  Ids `scumble_lora_1 .. n` (a taken id gets a suffix; flattened imports use `57:12`-style ids). The first node takes
  `model: [src, slot]`, each next one the one before; **every input of every node that equals `[src, slot]` is
  re-pointed to `[last, 0]`** (the chain's first node excepted): `flux3_klein_local`'s `sched` and `guider` both, the
  switch graphs' `on_true` LoRA and `on_false` (the recipe's turbo LoRA then stacks after the user's), the MOSS edit
  recipe's `slg` (its declared source is the edit LoRA node). With `clip`: `LoraLoader` nodes with `clip: [src,
  clipSlot]` → chained, `strength_clip = strength`, the CLIP consumers re-pointed to `[last, 1]`. The chain carries no
  picture and reads no canvas output, so `comfyRefSpec`, `trimSlots`, `kleinRun` and `wireBoxPrompt` are untouched;
  `runNodeCount` counts the new nodes (the bar's total).
- **`missingLoras(rows, names)`** → `[{ name, server }]` for the switched-on rows whose `name` is not in `names`
  (the server's `lora_name` combo) after `\` ↔ `/` normalisation; a row whose name differs only in separators gets
  `server` (the server's spelling), which the splice sends (the `checkModelFiles` precedent, `comfycloud.js:357-369`).
  **Only against a non-empty `names`:** with the node list unread (`objectInfo` null after a failed `/object_info`,
  `connected` still true, 1360) and the `/object_info/LoraLoaderModelOnly` re-read failed too, nothing is refused and
  the names go out as typed; Comfy's `value_not_in_list` then ends the run with its message, as a Cloud run does (the
  Settings rows' precedent: `missingSettingFiles` skips a combo without options, 1576). The combo is read through a
  `choicesOf`-shaped helper (`comfycloud.js`'s precedent) that takes both forms, `[[names], {}]` and `["COMBO", {
  options }]`, never `lora_name[0]` alone.
- **`familyOf(header, folder)`** (the reduced header answer of §3.4, or null) and **`recipeFamily(r)`** (§3.4).

**Where it runs (local):** `queueGenerate`, after `wireUpsampler`'s note (4132) and before `api.queuePrompt` (4142),
skipped for `upscale` and `pass` (no MODEL anyway): `const rows = this.loraRows(r)` (§3.3); `missingLoras(rows,
this.loraNames())` → a refusal in `missingFilesRefusal`'s shape (thrown among the refusals of 3990-3994, before
`ensureOnServer` (4087) uploads anything, since the rows need no state; against a non-empty list only, above); then
`spliceLoras(prompt, r, rows, this.objectInfo)`; `editor.lastRunNotes.push("LoRAs: " + applied)`; `editor.lastLoras =
applied` for the commands; the log line beside 4163-4165 ("local run <id>: LoRAs ..."); `viaLine(r, "your ComfyUI",
null, applied)` → "<model> via your ComfyUI + 2 LoRAs: a 0.8, b 1.0" (the stems, `replace(/^.*[\\/]/, "")` and the
extension off, as `renderPresets` does at 1525); `api.queuePrompt(0, { output: prompt, workflow:
this.workflowInfo({ loras: applied }) })`. `workflowInfo(extra)` gains `loras` (the run's) and `workflowForPng` passes
the switched-on rows of the selected recipe (what a run now would load). The LoRA list is read from the node list at
connect (`loraNames()`: the `LoraLoaderModelOnly` `lora_name` combo through the `choicesOf`-shaped helper; 1598 reads it
as `[0]` today) and re-read through `/object_info/LoraLoaderModelOnly` when the picker opens or a refusal is about to be
thrown (the 1302-1318 precedent): a file the user just copied in is in the server's list by then; a list that stays
empty refuses nothing (above).

### 3.2 The UI: the *LoRAs* section (`renderer/editor/lora_panel.js`, new, app-only DOM module)

- **Where:** `host.applyRecipe(ed)` (1673) calls `loraPanel.ensure(host, ed)`, which on the first call for an editor
  makes the section through `ed.addSection("LoRAs", false, (details) => box, "gen")` (`inpaint_modal.js:368`; the Boxes
  panel's way, `plugins.js:388-402`) **and moves the returned `<details>` to right after the Settings section**: `const
  after = ed.settingsList.closest("details"); after.parentNode.insertBefore(details, after.nextSibling)` (one DOM call
  in app-only code; `addSection` returns the element, §2.1); it keeps `ed._loraSection`; every later call re-renders.
  The order is then Prompt, Generate, Settings, **LoRAs**, History, Crop, and after Crop the plugin panels (the Boxes
  panel mounted on `"built"` at the constructor's end, §2.1: it stays where it is). Hidden (`details.hidden = true`)
  when `modelSource` answers none or many, for an API recipe that is not a Cloud graph recipe (`recipeMode` 1656), for
  the upscalers, the pass and relight; the summary's `title` carries the reason. Re-rendered on `onConnected` (the list)
  and on `host.on("recipe")`. No `inpaint_modal.js` change, no node build; §1 step 1's "after the Settings rows" is
  this.
- **Rows:** a grid in the Settings rows' look (`.ipc-settings`, `inpaint_canvas.js:1816-1818`; the skins' tokens): the
  on / off tick, a button with the stem (title: the full server name; `(not on the server)` in red when the current
  list lacks it, the `ipc-sel-missing` look of `renderSettings`, 23979-23985), the strength (`numberInput`'s shape,
  895; −2 .. 2 step 0.05, default 1.0; typed values clamped to the node's spec range from `objectInfo`, else −100 ..
  100), **×**; under the name the hint line (§3.4) and the trigger chips. **+** adds a row (greyed at five: "five LoRAs
  per recipe"). Every change writes the store (§3.3) and `ed.notifyChanged()` is not called (the rows are not document
  state). Disconnected: the stored rows shown, the picker says "Connect ComfyUI to pick LoRAs"; names are kept.
- **The picker:** a popover of the app's own (`ask()`'s and the relight tip's shape, `host.js`), opened at the name
  button: a search field (substring, any case, over the server name), the list grouped by subfolder (the part before
  the last `\` or `/`; root files under "(root)"), the recipe's family group first and the rest behind *Show all* when
  `recipeFamily(r)` is known and a group's hint matches (§3.4, by folder name and the cached hints); 1,201 plain rows
  render fine (no virtualisation); keyboard: arrows, Enter, Escape; a click picks. The list re-read on open.
- **Save as new recipe / Save to recipe** (`shell.js`' ComfyUI window actions): a new id starts with no rows unless it
  was saved from a recipe that has some: main's `comfyview:saved` payload gains `from: base ? base.id : null` (its two
  sends, `main.js:1035, 1047`; `heldId` is known there, `comfyview.js:509`, not in the shell), and the shell's handler
  (`shell.js:3319`) copies `host.loras[from]` to the new id when `from` differs from `id` (Save to recipe keeps the id,
  so nothing moves). Remove of a user recipe leaves its rows in the store (keyed by an id nobody shows; harmless, said in
  RECIPES.md).
- **Skins:** tokens only; the `skins` gate (`tools/skins_test.py`) renders every skin with the section open.

### 3.3 Storage: `settings.recipeLoras`

`{ [recipeId]: [{ name, strength, on }] }` in `settings.json`, beside `recipePresets` (not in `DEFAULTS`; read with
`|| {}` as `shell.js:3266` reads the presets): `host.loras`, loaded by the shell beside `host.presets`; `host.saveLoras
(recipeId, rows)` (the `savePresets` shape, 1459-1462: the whole object through `settings.set`); `host.loraRows(r)` →
the stored rows of `r.id`, the shipped shape checked (`name` a string, `strength` finite, `on` a boolean; a bad entry
dropped). Shared by all documents, as presets are (`docs/RECIPES.md:288`). No `.scumble` change, no `gen` key, no
history snapshot. `tools/settings_migration_test.js` gets a section: a profile without the key reads `{}`; a write of
another key keeps a stored `recipeLoras` whole; a malformed row is dropped by `loraRows`.

### 3.4 Detection and trigger words

- **Sources, in order.** (1) **Only when the server is this machine** (the host of `settings.comfy.url` a loopback
  address, `127.0.0.1` / `localhost` / `::1`, or the machine's own name, `os.hostname()` read once over the same IPC; a
  remote server, a RunPod say, never gets this source: a local file of the same name would speak for another file with a
  confident hint) **and** Settings › Helpers points at a ComfyUI models folder (`settings.helpers.dir`, `onnx/index.js:61`
  `isComfyDir`, `models.js:80-82` checks `checkpoints` / `diffusion_models` only) and `<dir>/loras/<name>` exists: main
  reads the safetensors header (8 bytes little-endian length, then JSON with the tensor keys and `__metadata__`; the
  length capped at 16 MB, ComfyUI's own endpoint stops at 1 MB; the path resolved and refused outside `<dir>/loras`) over
  a new IPC `loras:header` (`electron/main/loraheader.js`, pure over a buffer; `main.js` handler beside `recipes:*`
  1151-1155; preload beside `recipes` 126-132) and **answers a reduced shape, never the raw header** (an SDXL header lists
  2,958 tensors with dtype, shape and offsets, about 300 KB and more, and `ss_tag_frequency` runs to megabytes; a flat
  cap would truncate exactly the files most of the user's 1,201 are): `{ modules: [the distinct module paths with the
  adapter suffixes stripped: .lora_down.weight, .lora_up.weight, .lora_A.weight, .lora_B.weight, .alpha, .diff, .diff_b,
  .lora.up / .lora.down ...], keyCount, blocks: { <prefix>: the distinct block indices seen } for double_blocks,
  single_blocks, layers, transformer_blocks, content_mode_blocks, width: { <prefix>: the lora_B out-features of the first
  module under it (the hidden width, from the header's shape) }, metadata: { ss_base_model_version, ss_sd_model_name,
  modelspec.* (architecture, trigger_phrase, title), tags: the five most frequent of ss_tag_frequency, each shorter
  than 40 characters, computed in main } }`; `modules` capped at 2,000 entries and `metadata` at 16 KB, separately.
  `familyOf` runs in the renderer over that shape. (2) Else `/view_metadata/loras?filename=<name>` through
  `api.fetchApi` (metadata only; 404 → nothing; the same trimming in the renderer). (3) The subfolder name. Cached per
  server, name and session in `host`. `loras_test.js` has the remote case (a loopback URL reads the file, a remote one
  does not).
- **`familyOf(header, folder)`** → `{ family, label, from: "keys" | "metadata" | "folder", sure }`. The modules first
  (the table from `lora_ecosystem.md` §2, each a prefix or infix test on the module paths): `lora_te1_` / `lora_te2_` /
  `input_blocks` → SDXL; `lora_te_text_model` / `down_blocks` with `lora_unet_` → SD 1.5; `content_mode_blocks` →
  FLUX 3; `double_blocks` / `single_blocks` → **FLUX.1 or FLUX.2 / Klein, told apart by `blocks` and `width`** (FLUX.1
  dev and its LoRAs: 19 double and 38 single blocks at width 3072; FLUX.2 dev and Klein 4B / 9B differ in count and
  width; the user's folder is mostly FLUX.1 by name, so a FLUX.1 LoRA on `flux2_klein_local` must not read as a match:
  **the thresholds are read at LR3 from the user's `flux/`, `flux_2/` and `klein/` files and written into the table with
  a FLUX.1 fixture header; until verified the label is "FLUX.1 or FLUX.2" and counts as unknown for the amber line,
  never as a match**; 4B and 9B told apart by width once read, else not); `layers.N.proj.` or `proj.qkv` with
  `diffusion_model.`/bare → MOSS-Image; `layers.N.attention.to_k` → Z-Image; `transformer_blocks.N.attn.to_q` with
  `img_mlp.gate_up` or `txt_in.text_norm` → Qwen Image 2.1; `transformer_blocks.N.attn.add_k_proj` or `img_mod` → Qwen
  Image / Edit 2509 / 2511; nothing → unknown. Then metadata (`ss_base_model_version`, `modelspec.architecture`),
  labelled "metadata says", never over a keys answer. Then the folder ("in folder klein").
- **`recipeFamily(r)`**: a declared `r.loras.family`, else the graph's `CLIPLoader` `type` (`flux2`, `flux3`,
  `moss_image`, `qwen_image`, `lumina2`, `sdxl` ...), and for `qwen_image` a `QwenImage21Cache` in the graph → Qwen
  Image 2.1, else Qwen Image / Edit. The shipped recipes declare it (`flux3_klein_local` `flux3`, `qwen_image_edit_2_1_*`
  `qwen_image_2_1`, `moss_image_*` `moss_image`, `flux2_klein_local` `flux2`), so the hint never depends on a guess there.
- **The hint line:** grey "looks like FLUX 3" / "metadata says SDXL" / "in folder klein"; amber when the family is known
  on both sides and differs (§1 step 2's sentence). **Never a refusal.** The ComfyUI console's "lora key not loaded"
  lines are the server's; the manual says where to look.
- **Trigger words:** `modelspec.trigger_phrase` first, then the top five tags of `ss_tag_frequency` (JSON per dataset:
  tag → count; the most frequent five, each shorter than 40 characters), as chips; a click appends `, <word>` to the
  prompt through the editor's prompt setter (the `set_prompt` path). Civitai's Qwen 2.1 entries carry no trigger words
  (the research read `trainedWords` empty there, `lora_ecosystem.md` §6), and ai-toolkit files like the user's write
  `ss_tag_frequency` only when trained with captions, so the row often shows nothing. No network beyond the server (no
  Civitai lookup).

### 3.5 Comfy Cloud

- **The probe (LR5, read-only, the user's key typed into a test instance as on 2026-10-18):** `GET /api/v2/assets`
  with the key (the SDK's listed route; what it returns and whether an import appears there), the v1 `/api/object_info`
  `LoraLoaderModelOnly` combo (what `cloudInfo` already reads), and whatever route docs.comfy.org/cloud names for the
  account's models at the time. Comfy Cloud's own MCP server lists the account's models (`search_models owned:true`), so
  a route exists; the user's account has no imported LoRA today (0 on 2026-11-06), so a listing can only be confirmed
  with one import (Creator plan or higher, Civitai or Hugging Face URL): the user's call, asked at LR5.
- **Either way the row works:** found → the picker lists the account's LoRAs beside Comfy Cloud's shared list (the
  live `LoraLoaderModelOnly` combo, which omits `moss_*` though the catalog has them: never a refusal on Cloud); not
  found → the picker lists the shared combo and takes a typed name, with the note "LoRAs you import on Comfy Cloud's site
  (Creator plan or higher) are used by their file name; Comfy Cloud's list does not show them."
- **The request (both paths):** `host.runProvider` (2041; the edit request at 2105-2112) **and** `runGenerate`'s own
  Generate new request (`kind: "text"`, 2586-2597, which never goes through `runProvider`, §2.1) add `loras: { rows:
  this.loraRows(r), declared: v.loras }` when the resolved variant is a Cloud graph recipe (`options.graph`); `v.loras`
  is the variant's declaration (below), sent on the request itself because `buildDetached` reads only `req.options`
  (§2.1); the dialog's layout request (1947) carries none (the layout needs none). `electron/main/providers/index.js`
  passes `req.loras` through (`shape()` at 268 logs the row count).
- **Where main splices: in `run` and `runV2`, after `cloudInfo`'s read and before `checkModelFiles`** (592-607 and
  752-782), never inside `buildDetached`: `req = { ...req, options: { ...req.options, graph } }` with `graph` a copy of
  `req.options.graph` that `spliceLoras(graph, { loras: req.loras.declared }, req.loras.rows, entry.info)` wrote the
  chain into (the node list from the same `cloudInfo` entry: `modelSource` needs `output` per class, which v1
  `object_info` has; `runV2`'s `entry` null → the class-name table). So `modelFiles` counts the chain's `lora_name`
  values, `checkModelFiles` fixes a separator on them and `missingNote` names a LoRA Comfy Cloud's list lacked, and
  `buildDetached` (394-431) stays **untouched**: it copies `o.graph`, which now holds the chain. The module is loaded
  in main by `require()` of the ES module (`comfysdk.js:31-34`'s `require(esm)`; checked at LR0 on a local file: if
  Electron's Node refuses it, a CJS twin `electron/main/providers/lorasplice.js` held to one case file
  `tools/loras_cases.json`, the refs grammar's precedent, `docs/TESTING.md:254`).
- **The answer:** main's result gains `loras: [{ name, strength }]` (what was spliced, in the Cloud list's spelling
  where a fix applied); `runProvider` passes it to `viaLine(r, label, res.seconds, res.loras)` at 2133 and sets
  `editor.lastLoras`; `runGenerate` puts "LoRAs: ..." into its notes (its result is a new base: no history entry,
  §2.1) and `generate_new` answers `loras_sent` from it; the upscale's via at 2319 stays (no MODEL). `workflowForPng`
  reads the selected recipe's rows, so the PNG chunk needs nothing more.
- **The declaration on a Cloud recipe is a variant field** beside `refs` and `limits`: `providers.comfycloud.loras`,
  written by `tools/cloud_recipes.js` `build` (72-90) from a MANIFEST field (`cloud_ideogram_4`: `loras: false`, two
  MODEL sources). `normalize` validates `loras` (`false`, or `{ model?: string, family?: string }`) **in both branches**:
  for a ComfyUI recipe against `r.prompt` in the comfy branch (beside `boxes` and `upsampler`, 605-622), for a provider
  recipe in the provider loop (630-650) per variant **and per route** (`options.graph` and `text.options.graph`, both
  of `cloud_flux2_klein_9b` and `cloud_qwen_image_2_1_edit`): `false` holds for both routes, a `model` id is resolved
  against each graph and dropped for a route whose graph lacks it (a warning, the generic rule then applies there), a
  `family` string is kept. `host.recipeMode(r) === "cloud"` reads the resolved variant's `loras`; `GRAPH_KEEPS` gains
  `"loras"`; `detach` (1554) writes a local recipe's `loras` into the Cloud copy's variant. RECIPES.md says where the
  field sits for each kind.
- **Relight on Comfy Cloud** (`recipes/relight.json`) is not in scope (the relight route builds its own request).

### 3.6 MOSS Image Edit

- **`recipes/moss_image_edit_local.json`** (new): `name` "MOSS-Image Edit (ComfyUI)", `mode local`, `canvas`,
  `result "decode:0"`, `refs: { "name": "image {n}", "slots": 4 }` (a plain phrase: the `Moss-Image-Edit` format puts no
  markers into the text; LR9's run with two references decides and changes it if needed, §7), `family` "moss_image" via `loras: { "model": "lora", "family":
  "moss_image" }` (the user's rows after the edit LoRA), `needs` with `LoraLoaderModelOnly` and
  **`TextEncodeMOSSImageEdit`** (a v0.42 server: "The server lacks these node types: TextEncodeMOSSImageEdit";
  `list_recipes` `ready: false` with the same reason, `recipeReadiness` 411-426), `description` with "ComfyUI 0.43 or
  newer", the licence sentence and the template's notes. The graph (the research's sketch, held to the template):
  `img0..img3` `ImageFromBatch` of `["canvas", 0]`; `scale0..3` `ImageScaleToTotalPixels` (lanczos, 1 MP, 16) each;
  `size` `GetImageSize(scale0)` → `latent` `EmptyFlux2LatentImage`; `unet` `UNETLoader moss_image_sft_bf16` (the user's
  file; the `models` rows list `moss_image_sft_int8_convrot` too); `lora` `LoraLoaderModelOnly(["unet", 0],
  moss_image_edit_lora_rank_64_bf16.safetensors, 1)`; `slg` `SkipLayerGuidanceDiTSimple(["lora", 0], "", "22", 0, 1)`;
  `clip` `CLIPLoader(qwen3.5_9b_int8_convrot, moss_image)`; `vae` `VAELoader(flux2-vae_small)`; `pos` and `neg`
  `TextEncodeMOSSImageEdit(clip, prompt ["canvas", 7] / ["canvas", 12], vae, "Moss-Image-Edit", images.image_0..3 =
  scale0..3, image_strength 1)`; `ks` `KSampler(["slg", 0], seed ["canvas", 10], 30, 4, euler, normal, pos, neg,
  latent, 1)`; `decode` `VAEDecode`. **Settings rows (eight):** 1 Model (`unet.unet_name`), 2 Text encoder, 3 VAE, 4
  **Edit LoRA** (`lora.lora_name`: a file combo, so the missing 297 MB file is refused with its download link before the
  run, issue #4's `missingFilesRefusal`, and the Preset row works), 5 LoRA strength (`lora.strength_model`), 6 Steps,
  7 CFG, 8 Megapixels (`scale0.megapixels`: **the picture being edited alone**; the three reference scalers stay at the
  file's 1 MP, since a Settings row writes one input, 4107-4111; the description and RECIPES.md say so, and LR9 judges
  whether the references should follow the output's size, as the re-packager's notes want; a four-node write is not in
  this plan). Sampler, scheduler, SLG window and `edit_format` stay the template's values in the file (§6 Q1 on the
  ai-toolkit LoRAs). `models.loras`: the Comfy-Org link; `models.diffusion_models` / `text_encoders` / `vae` as
  `moss_image_local` has them. No `boxes` (an edit is untrained on a layout).
- **`comfyrefs.js` ENCODERS** gains `TextEncodeMOSSImageEdit: { name: "image {n}", inputs: keys /^images\.image_\d+$/
  sorted numerically → [k, i + 1] }` (0-based keys numbered by rank, as the node sorts the present keys). The identity
  trace accepts the two encoders (§2.1); `trimSlots` leaves out `images.image_k` of both when a picture is absent.
  `comfyrefs.js` is app-only. The stitch composites the crop by the selection (no mask input, as Qwen and Klein).
- **`cloud_moss_image_edit`** (LR7): the template export into `tools/refs/comfy_cloud/edit/image_moss_image_edit.json`
  (Comfy's export, MIT; the research's copy from the `workflow_templates` repository, frontend 1.57.1, carries
  `widgets_values_named` on all 15 widget nodes as the thirteen Cloud exports do, so `fromWorkflow` keeps every widget
  of a class the fixture node list lacks, §2.1), a MANIFEST row in `tools/cloud_recipes.js` (`loras: { model: <the LoRA
  node's id> }`, a variant field, §3.5), **the specs of both `TextEncodeMOSSImageEdit` and `SkipLayerGuidanceDiTSimple`
  into `tools/refs/comfy_templates/object_info.json`** (from Comfy Cloud's `/api/object_info` read with the key, the
  research's `get_node` record, or the user's v0.44.0 `/object_info` once the server runs; without them
  `recipes_test.js` §10's required-input check reads `info[class]` as undefined and checks nothing for those nodes),
  **§10's `want` table to fourteen** and a check that the generated `slg` holds `double_layers`, `single_layers`,
  `start_percent`, `end_percent` and each encoder its `edit_format`, `image_strength` and `images.image_0` (the
  template's widget values, now readable against the specs); the MOSS text-to-image template as its `text` route when
  its export is at hand (`t2i/` has none today). The template's one `LoadImage` gives a one-picture recipe; more pictures
  need titled nodes (`scumble:picture:n`, `recipes.js:1113-1124`) in a later update. **The Cloud variant runs once live
  at LR5** (an edit of a selection, a few cents, beside the LoRA run) or RECIPES.md says it has not run.
- **The licence sentence** (the recipe's description, RECIPES.md, the manual): "The edit LoRA is chinoll's
  Moss-Image-Edit, rehosted by Comfy-Org, whose repository card says Apache-2.0; chinoll's own repository names no
  licence for the weights (its code is GPL-3.0). MOSS-Image's weights are Apache-2.0."

### 3.7 The ComfyUI update (LR8; decision 7)

**The folder is at v0.44.0 already** (read 2026-11-06 evening, §0): HEAD is the tag `v0.44.0`, the backup branch
`backup_branch_2026-11-06_02_55_11` exists, the pins are written (§2.3). So **steps 1 and 2 run only if
`comfyui_version.py` is below the target at LR8's start** (a newer stable may be out by then; whether to take it is the
user's call, asked with the diff); **else LR8 is steps 3 to 5**: the checks on the running server, the LoRA download
and the record, where the pins already applied are recorded as `git diff backup_branch_2026-11-06_02_55_11 v0.44.0 --
requirements.txt` in `ComfyUI/` and the freeze taken then is the "after" (the "before", if one was kept, is in the
session that ran the update). The user present; ComfyUI stopped by the user (or its queue empty and then stopped) for
steps 1-2; no benchmark of the kernel branch running on this machine (asked in chat first); nothing written into
`custom_nodes` (the hot-reload trap). Steps:

1. **The target and the pins.** The newest `v*` tag **as `update.py` will pick it** (`git ls-remote --tags
   https://github.com/Comfy-Org/ComfyUI 'v*'`, sorted numerically the way `latest_tag` sorts, §2.4; not
   `releases/latest`, which can lag a tag or lead it); the target's `requirements.txt` into the scratchpad; **its diff
   against the installed `ComfyUI/requirements.txt`** (never the research's table, §2.3); `python_embeded\python.exe -m
   pip freeze` into `docs/measurements/lr8_<date>/pip_freeze_before.txt`; `pip check` before (the baseline: the ~130
   packs' own conflicts, which a dry run of one file does not see); `python_embeded\python.exe -m pip install --dry-run
   -r <target>` → every package that would change, with its version before and after, **shown to the user in chat before
   anything is installed**; what the dry run cannot see, `pip check` after the install says (step 2).
2. **On the user's yes:** the tag read again immediately before the script; **moved → the new diff first**. Then, from
   the `update\` folder (its paths are relative to it), `update_comfyui_stable.bat nopause` (any first argument skips
   the trailing `pause`, which otherwise hangs a non-interactive run, §2.4), or `update.py` twice as the bat does
   (`..\python_embeded\python.exe .\update.py ..\ComfyUI\ --stable`; if `update_new.py` appears, move it over
   `update.py` and run again with `--skip_self_update --stable`); the stash, the backup branch, master, the newest `v*`
   tag, pip when the requirements differ. **A pin held back** (a frontend version, say): `update.py` runs pip
   unconditionally whenever `update/current_requirements.txt` differs (§2.4), so the target's `requirements.txt` is
   copied over `update/current_requirements.txt` first (pip is then skipped), the git part runs through the script, and
   the packages are installed by hand from the dry run's file with the held pin edited: what was shown is what is
   installed. The backup branch's name and the stash recorded; `pip check` after, against the baseline.
3. **The user starts ComfyUI.** Checks: `/system_stats` (the version), `/object_info` holds `TextEncodeMOSSImageEdit`,
   `InpaintCanvas` (23 outputs, `box_prompt`, `elements`), `LoraLoaderModelOnly`, `SAM3Segment`, `DLSS5Settings`,
   `RTXVideoSuperResolution`, `TextGenerate`; the console's import failures among the 142 `custom_nodes` entries,
   **read in this order:** the packs Scumble's recipes need (`ComfyUI-InpaintCanvas`, `comfyui-rmbg`,
   `ComfyUI-DLSS5-Enhancer` with `dlss5_fit_size`, `Nvidia_RTX_Nodes_ComfyUI`), then the known breakers on a core bump
   (`ComfyUI-HotReloadHack`, which patches core internals; `ComfyUI-nunchaku`; `ComfyUI-GGUF`; `ComfyUI-Manager`;
   `RES4LYF`; `comfyui-kjnodes`; `ComfyUI-WanVideoWrapper`; `ComfyUI-LTXVideo`; `comfyui-impact-pack`; `was-ns`;
   `comfyui_controlnet_aux`), then the rest; Scumble's ComfyUI window loads the new frontend (one look; the `comfyview`
   gate's control step is a known flake); one Scumble run on `flux3_klein_local` without LoRAs (the queue checked
   first).
4. **The edit LoRA** (297 MB) into `models/loras/` from Comfy-Org's URL, sha256 against the Hugging Face API's lfs
   hash (the 2026-10-22 way), on the user's yes in chat (§6 Q2).
5. **Rollback, if needed:** `git checkout <the backup branch>` in `ComfyUI/`, `pip install -r` that branch's
   `requirements.txt` (`git show <branch>:requirements.txt`, kept in the measurements folder), the user restarts.

Record: `docs/measurements/lr8_<date>/summary.txt` (versions before and after, the pins diff, the dry run, `pip check`
before and after, the freeze, the object_info checks, the import failures, the stash and backup names). Committed with
the session.

### 3.8 MCP and the assistant

- `set_generation` gains `loras: [{ name, strength?, on? }]` (the selected recipe's rows, replaced whole; app-wide per
  recipe, said in the description; `[]` clears; more than five, a name not in the server's list (separators
  normalised; the server's spelling taken), a recipe without a model source → refused with the reason, nothing
  changed); its answer gains `loras`. `status` gains `loras: { takes, reason, rows: [{ name, strength, on, hint }],
  sent: [names] }` (`sent`: what a run now would load). `list_recipes` gains `loras: true | false | null` (null while
  the node list is unread) and `loras_reason`. `generate` and `generate_new` answer `loras_sent`. **`list_loras`**
  (read-only, `filter`, `max` default 200, `family`): the server's names grouped by folder with the cached hint where
  known, `total`. Policy: `list_loras` in READS and AUTO; `set_generation` stays AUTO. `docs/COMMANDS.md` headings, the
  `.mcpb` (`tools/mcpb_test.js:44-45` counts them against the bundle), the assistant's tool list
  (`tools/assistant_test.js:681-682`, `>= 116`). **The tool count a session writes is COMMANDS.md's heading count at
  that commit** (`grep -c '^### \`' docs/COMMANDS.md`; 116 today): LR4 lands 117 in README 83 and 303 **with the core
  sub-count 96 → 97** (`list_loras` is a core command) and in `docs/MCP.md:306`, and **the same commit amends
  `PLAN_CORRIDORKEY.md` §4.8 (831) and I7's done criterion (1028) from "117" to "+1 on what README says at the time"**,
  so I7 lands 118 / 98 after LR4 or 117 / 97 before it, whichever session comes first (the branch owns both plans).
  README and MCP.md are prose: the release block checks them against the count (§5).

### 3.9 The docs

`docs/MANUAL.md` Recipes chapter (146-172): a paragraph *LoRAs on your ComfyUI and Comfy Cloud* (the section, the five
rows, where the names come from, the hint and what it cannot promise, the trigger chips, the refusal, Comfy Cloud's
imports, the console's "lora key not loaded" line), and the MOSS Image Edit recipe beside MOSS-Image (0.43 or newer, the
LoRA's download and licence, the pictures' names as the live run found them); README's "On your own ComfyUI" bullet
(220-225) and the tool count as §3.8 rules it; `docs/RECIPES.md`: the `loras` field (`false`, `{ model, family }`; on a
ComfyUI recipe at the top, on a Cloud recipe in the variant, holding for both of its graphs), the splice rule, the
store, the MOSS edit recipe entry (the Megapixels row's reach, §3.6), the Cloud variant (and whether it ran);
`docs/COMMANDS.md`; the new gate **`loras`** in the places that list gates: CLAUDE.md:819's list, `tools/run_gates.sh`'s
header comment and `docs/TESTING.md`'s gate table (`tools/loras_test.py` runs `node tools/loras_test.js` first, the
`recipes` gate's precedent, `run_gates.sh:25`); CHANGELOG `## Unreleased` lines per session, folded into `## 0.1.52 -
<date>` with CorridorKey's at the release; CLAUDE.md item 50 and the "Where things stand" line only; `docs/BUGS.md`:
the relight recipe's `lora_name` line (LR0). The issues' replies (§6 Q3) drafted for the user.

## 4. Sessions

**Rules for every session** (CLAUDE.md "Working rules"; `PLAN_CORRIDORKEY.md` §5): one numbered section per sitting,
its commit as DenRakEiw without a trailer, **the branch pushed**, measurements under `docs/measurements/lr<step>_<date>/`,
the hand-over line in CLAUDE.md "Where things stand" and item 50's block, a CHANGELOG `## Unreleased` line for what the
user notices, then `/clear`. Every app gate `--offline` (the queue stubbed, as the Q1 Klein steps do); one instance at a
time, the dev instance on port **9571** from the worktree (`node_modules` a junction to `F:/canvas/node_modules`,
`PLAN_CORRIDORKEY.md` §4.10). **Every live run on the user's ComfyUI only on their word, `/queue` checked first, own
prompts taken off, never a restart by Claude.** Stage by explicit path and check `git diff --cached --name-status`.
**Tiers:** the splice, the header reader and the recipe files Light (plain Node against every shipped recipe and
fixture headers); the UI Normal on tiles plus `skins`; persistence through the settings migration test; the queue path
through the new `loras` gate and the `generate` / `commands` gates with the host stubbed; the live runs the feature's
test. Nothing Full (no Rust kernel, no `.scumble` field, no compositor or export writer change: the PNG chunk gains a
key, the writer is untouched). **No shipped editor file changes** (`loras.js`, `lora_panel.js`, `comfyrefs.js`,
`comfyprompt.js`, `host.js` are app-only; `build_node.py --check` run at LR6 to prove it and again, read-only, in the
release block, since `host.js` and `lora_panel.js` move again in LR5 after it), so **no node build**. The new gate
`loras` = `tools/loras_test.py`, which runs `node tools/loras_test.js` first (the `recipes` gate's precedent,
`run_gates.sh:25`) and then the app steps; LR10 adds it where gates are listed (§3.9). The behaviour sentence of §1 is
repeated in chat before LR1 and LR2.

Efforts in days, **inferred**.

| # | Session, goal | Files (anchors) | Tests (tier) | Done when | Effort |
|---|---|---|---|---|---|
| **LR0** | **The splice module and the recipe declaration.** `renderer/editor/loras.js` (`modelSource`, `spliceLoras`, `missingLoras` (nothing against an empty list), `normalizeName`, `choicesOf`-shaped `comboOf`, `MAX_LORAS`; `familyOf` / `recipeFamily` as stubs for LR3); `recipes.js` `normalize` validates `loras` **in both branches** (the comfy branch beside `boxes` 605-612 against `r.prompt`; the provider loop 630-650 per variant and per route, `options.graph` and `text.options.graph`, §3.5), `GRAPH_KEEPS` (1067) gains it, `detach` (1554) writes it into the Cloud copy's variant; the shipped local recipes declare `loras.family`; `tools/cloud_recipes.js` `build` writes a MANIFEST `loras` into `providers.comfycloud` (`loras: false` for `cloud_ideogram_4`) and the files are regenerated (`--check`); the `docs/BUGS.md` line on `relight_qwen_local`'s `lora_name` values; `require()` of the ES module from a CJS scratch script under Electron's Node (the SDK precedent) tried once and recorded (§3.5) | `renderer/editor/loras.js` (new), `electron/main/recipes.js`, `tools/cloud_recipes.js`, `recipes/cloud_ideogram_4.json`, `recipes/*_local.json` (the declaration only), `tools/loras_test.js` (new), `tools/recipes_test.js`, `docs/BUGS.md` | Light: `node tools/loras_test.js` over every shipped recipe (raw and normalised, the `comfyprompt_test.js` loader): the five local edit / generate recipes each one source and a chain with every consumer re-pointed (`flux3_klein_local`'s `sched` and `guider`), the recipe's own graph untouched, rows switched off or at an empty name absent, five rows in order with their strengths, the sixth refused; the switch graphs of `cloud_anima_base`, `cloud_flux2_dev`, `cloud_krea_2_turbo`, `cloud_qwen_image_edit_2509` (both branches re-pointed); the patch graphs (`QwenImage21Cache`, `ModelSamplingAuraFlow`, `SkipLayerGuidanceDiTSimple`) splice before the patch; the three upscalers none; `cloud_ideogram_4` declared none; **a Cloud recipe with an edit and a text graph (`cloud_flux2_klein_9b`): `loras: false` holds for both, a declared `model` honoured where the graph has the node and dropped with the warning where it does not**; a checkpoint-loader fixture → `LoraLoader` with `strength_clip` and the CLIP consumers re-pointed; a fixture with ids `57:12` and one with `scumble_lora_1` taken; a Nunchaku class → none; a declared `model` that reads a MODEL accepted, one naming no node dropped by `normalize` with the warning; `missingLoras` with `\` and `/`, and with an empty list (nothing refused); the combo helper on `[[names], {}]` and `["COMBO", { options }]`; `node tools/recipes_test.js` (the `loras` field through `fromGraph`, `detach`, `cloud_recipes.js --check`); `lint`, `types` | the tests green; every shipped recipe's source and chain listed in the test's output; the `require(esm)` result in the hand-over | 0.75 |
| **LR1** | **The queue path, the store and the metadata.** `host.loras` / `saveLoras` / `loraRows` / `loraNames` (beside the presets, 1449-1462; loaded at `shell.js:3266`'s neighbour; the combo through the helper, both forms); the refusal and the splice in `queueGenerate` (§3.1; the refusal among 3990-3994, before `ensureOnServer` 4087, and only against a non-empty list; the splice between 4132 and 4142); `viaLine(r, route, seconds, loras)` (237) and the result's `via` (4186, 5412); the status note and the log line (4163-4165); `workflowInfo(extra)` (4243) and `workflowForPng` (4232); the list re-read through `/object_info/LoraLoaderModelOnly` (the 1302-1318 shape) | `renderer/editor/host.js`, `renderer/shell.js`, `tools/settings_migration_test.js`, new gate **`loras`** = `tools/loras_test.py` (runs `node tools/loras_test.js` first, then the app steps) | Normal: `node tools/settings_migration_test.js` (the key absent → `{}`; a write of another key keeps it; a malformed row dropped); the `loras` gate on tiles (the Q1 Klein stub, `generate_test.py:2500-2508`: `host.loras` set, `host.objectInfo` with a LoRA combo of names with backslashes): the queued body holds the chain in order with the strengths and every consumer re-pointed, `r.prompt` untouched, a switched-off row absent, a row at a name the list lacks refused before `ensureOnServer` with the sentence, **the node list unread (`objectInfo` null, the re-read stubbed to fail) → no refusal and the names sent as typed**, a name differing in separators sent in the server's spelling, `extra_pnginfo.workflow.loras` the run's, `_sentTexts.get(id).via` carrying "+ 2 LoRAs: ..." and the log line present; `metadata` (the tEXt chunk carries `loras` with the switch on and not with it off), `generate`, `recipes`; `lint`, `types` | the gate green on tiles; a run on the dev instance against the stub shows the via line in the history | 1 |
| **LR2** | **The LoRAs section** (§3.2): `lora_panel.js` (the section through `ed.addSection` **and moved to right after the Settings `<details>`**, the rows, **+**, ×, the strength, the on / off tick, the picker popover with search and folder groups, the disconnected state, the hidden states with their reasons), `applyRecipe` (1673) calling it, main's `comfyview:saved` payload gaining `from` (1035, 1047) and the shell copying `host.loras[from]` to the new id (3319); `loras.js` `groupByFolder`, `filterNames` | `renderer/editor/lora_panel.js` (new), `renderer/editor/loras.js`, `renderer/editor/host.js`, `renderer/shell.js`, `electron/main/main.js` (the payload) | Normal: the `loras` gate's UI steps (the section present under `flux3_klein_local` **as the `<details>` right after Settings, before History, with the Boxes panel still after Crop**, hidden under `qwen_image_edit` (API), `rtx_vsr_local`, `realism_pass` and a `loras: false` fixture with the reason in the summary's title; **+** adds rows up to five, the sixth greyed; a pick through the popover's search lands in the store and in the next queued prompt; the strength clamped; × removes; the rows survive a recipe switch and come back; a `comfyview:saved` with `from` copies them to the new id, one without `from` or with `from === id` copies nothing), `skins` (every skin, the section open), `editor`; one look in the app | the gate green on tiles; the section used by hand on the dev instance against the stub | 1.5 |
| **LR3** | **Detection and trigger words** (§3.4): `electron/main/loraheader.js` (pure: the header from a buffer or a path, the 16 MB cap, the path check, **the reduction to `{ modules, keyCount, blocks, width, metadata }` with the top tags computed there**, the two caps), the IPC `loras:header` (`main.js` beside 1151-1155, `preload.js` beside 126-132) **taken only for a loopback or own-host server URL**, the `/view_metadata` fallback (the same trimming), `familyOf(header, folder)` / `recipeFamily`, **FLUX.1 against FLUX.2 / Klein by block count and width, the thresholds read from the user's `flux/`, `flux_2/` and `klein/` files by hand**, the hint and the amber line, the chips and the prompt append, the picker's family group and *Show all* | `electron/main/loraheader.js` (new), `electron/main/main.js`, `electron/preload.js`, `renderer/editor/loras.js`, `renderer/editor/lora_panel.js`, `renderer/editor/host.js`, `tools/loraheader_test.js` (new) | Light: `node tools/loraheader_test.js` on synthetic safetensors files the test writes (a few keys per family from `lora_ecosystem.md` §2's lists with shapes, **a FLUX.1 case (19 double, 38 single, width 3072) and a Klein case**, an SDXL case of 2,958 keys whose reduced answer stays under 64 KB, `__metadata__` lying as `anna_qwen`'s, an `ss_tag_frequency` of 1 MB reduced to five tags, a header past the cap refused, a file that is no safetensors → null, a `..` in the name refused); `loras_test.js` family cases (keys over metadata over folder; the Qwen 2.1 / 2509 split; **FLUX.1 against FLUX.2 by the fixture's counts, and "FLUX.1 or FLUX.2" as unknown, never a match, while the thresholds are unverified**; a remote server URL → no header read, metadata and folder only); the `loras` gate's hint steps (a stubbed header answer → the grey line; a mismatch → the amber line and no refusal; a chip click appends to the prompt); `lint`, `types` | the tests green; on the dev instance with Settings › Helpers at the user's ComfyUI models folder, `Flux3_Targa` reads "looks like FLUX 3", `anna_qwen` reads its keys, not its metadata, and a `flux/` LoRA under `flux2_klein_local` turns the line amber (the user's files read by hand, nothing written); the thresholds in the table with their source | 1.25 |
| **LR4** | **MCP** (§3.8): `set_generation` `loras`, `status.loras`, `list_recipes` `loras` / `loras_reason`, `generate` / `generate_new` `loras_sent`, `list_loras`; the policy rows; `docs/COMMANDS.md`; the tool count in README 83 and 303 (the core sub-count too) and `docs/MCP.md:306` **as COMMANDS.md's heading count at the commit** (117 / 97 if LR4 comes before I7, 118 / 98 after); **the same commit amends `PLAN_CORRIDORKEY.md` §4.8 (831) and I7 (1028) to "+1 on what README says"** | `renderer/commands.js` (1220, 915, 853, 1631, 1345), `electron/main/assistant/policy.js` (14-17, 59), `docs/COMMANDS.md`, `README.md`, `docs/MCP.md`, `docs/PLAN_CORRIDORKEY.md` (two lines) | `commands` (a `set_generation loras` step against the stub: stored, refused at six and at a name the list lacks, `status.loras.sent` right, `generate`'s `loras_sent`, `list_loras` with `filter`), `mcp`, `mcpb`, `assistant`, `lint`, `types`; `grep -c '^### \`' docs/COMMANDS.md` against README and MCP.md by hand | the gates green; README and MCP.md carry the heading count | 0.5 |
| **LR5** | **Comfy Cloud** (§3.5): the probe (the user's key in a test instance; `/api/v2/assets`, the v1 combo, the documented account route; one import only on the user's word), then the row's source accordingly (**found → the account's LoRAs in the picker; not found → the typed name with the note, built without a question**, §0's decision); `req.loras = { rows, declared }` from `runProvider` (2105-2112) **and from Generate new's own request (2586-2597)**; **the splice in `run` and `runV2` after `cloudInfo` and before `checkModelFiles`** (592-607, 752-782) through the module (or the CJS twin), `buildDetached` untouched; main's answer `loras`, `viaLine(..., res.loras)` at 2133, the Generate new note and `editor.lastLoras`; `cloud_ideogram_4` hidden with its reason; the picker's note | `electron/main/providers/comfycloud.js`, `electron/main/providers/index.js`, `renderer/editor/host.js`, `renderer/editor/lora_panel.js`, `tools/cloudgraph_test.js` / `tools/comfycloud_v2_test.js` (on `tools/fake_comfy_v2.js`), `docs/measurements/lr5_<date>/probe.md` | Light: the graph Comfy receives holds the chain (the switch graphs both branches, the patch graphs before the patch), **a name differing in separators goes out in the Cloud list's spelling (the fix reached the chain), a name the list lacks goes out and the failure's note names it, the answer's `loras` lists what was spliced and the via text carries it**, `loras: false` leaves both graphs alone, **a declared `model` honoured on the edit graph and a text graph without it left to the generic rule**, an unread node list (`entry` null) splices by the class-name table; the `loras` gate's **Generate new step on `cloud_flux2_klein_9b` against the `fake_comfy_v2` mock: the text graph the mock receives holds the chain and the answer's note names it**; `commands` (`list_recipes` `loras` for a Cloud recipe, `generate_new`'s `loras_sent`); **live, on the user's word:** one Cloud run of `cloud_qwen_image_edit_2509` with one shared-catalog LoRA and **one of `cloud_moss_image_edit`** (a few cents together), the pictures and the via line judged | the tests green; the probe's answer in the hand-over and the row's source decided by it; the Cloud MOSS edit's run recorded (or RECIPES.md says it has not run) | 1.25 + the probe's time |
| **LR6** | **The MOSS Image Edit recipe (local)** (§3.6): `recipes/moss_image_edit_local.json`, the ENCODERS entry, the description, `docs/RECIPES.md`'s entry; `python tools/build_node.py --check` (no shipped file changed; again, read-only, in the release block, §4) | `recipes/moss_image_edit_local.json` (new), `renderer/editor/comfyrefs.js` (37-62), `docs/RECIPES.md`, `tools/comfyrefs_test.js`, `tools/recipes_test.js`, `tools/loras_test.js` | Light: `node tools/comfyrefs_test.js` (the spec: `image {n}`, 4 slots, an identity with two encoders, `trim` for both), `recipes_test.js` §1 (eight slots, each its own) and §5 (the graph round trip), `loras_test.js` (the declared source `lora`: the user's chain after the edit LoRA, `slg` re-pointed), `cloud_recipes.js --check`; `recipes` gate; the `loras` gate's readiness step (`needs` without `TextEncodeMOSSImageEdit` in the stubbed node list → the sentence, `list_recipes` `ready: false`); `build_node.py --check` ok | the tests green; the recipe listed in the dev instance with the readiness sentence against a v0.42 node list | 0.75 |
| **LR7** | **The Comfy Cloud variant** `cloud_moss_image_edit` (§3.6): the export into `tools/refs/comfy_cloud/edit/` (its `widgets_values_named` checked present), the MANIFEST row (`loras: { model }` as a variant field), **the specs of `TextEncodeMOSSImageEdit` and `SkipLayerGuidanceDiTSimple` into `tools/refs/comfy_templates/object_info.json`**, the t2i pairing when the template is at hand | `tools/cloud_recipes.js`, `tools/refs/comfy_cloud/edit/image_moss_image_edit.json`, `tools/refs/comfy_templates/object_info.json`, `recipes/cloud_moss_image_edit.json` (generated), `tools/recipes_test.js`, `docs/RECIPES.md` | Light: `cloud_recipes.js --check`, `recipes_test.js` **§10 with its `want` table at fourteen** (the shipped-recipe checks are §10, not §8) **and a check that the generated `slg` holds `double_layers`, `single_layers`, `start_percent`, `end_percent` and each encoder its `edit_format`, `image_strength` and `images.image_0`** (the required-input check now sees both classes), `cloudgraph_test.js` (the roles: the crop, the prompt, the negative, the seed, the size), `loras_test.js` (the declared source) | the file written by the tool and checked; the recipe listed under *comfy cloud* in the dev instance; its live run is LR5's | 0.5 |
| **LR8** | **The ComfyUI update** (§3.7; decision 7; the user present). **The folder is at v0.44.0 since 2026-11-06 02:55 (§0): steps 1-2 run only for a server below the target at the session's start** (the newest tag as `update.py` picks it, the pins diff against the installed file, `pip check` and the dry run **shown before anything is installed**, the freeze, the script with its `nopause` argument from `update\` on the user's yes, the tag re-read right before it); **else the session is steps 3-5:** the user's restart, the checks (the pack list in §3.7's order), the edit LoRA's download with sha256 on the user's yes, the record with the applied pins read from the backup branch | `docs/measurements/lr8_<date>/` (summary, the pins diff, the dry run and `pip check` where they ran, the freeze, the object_info checks); nothing in the repo's code | none (a change of the user's machine); the checks of §3.7 step 3 | `/system_stats` names the version (0.44.0 or the newer target); `/object_info` holds `TextEncodeMOSSImageEdit` and every class Scumble's recipes need; the import failures listed; a `flux3_klein_local` run lands; the LoRA file present with its hash | 0.25-0.5 + the user's time |
| **LR9** | **The live runs** (the user's word, `/queue` first, the user's ComfyUI at 8188): **LoRAs:** one run per family with a LoRA from the matching folder (`Flux_3/Flux3_Targa` on `flux3_klein_local`, a `klein/` LoRA on `flux2_klein_local`, a Qwen Image 2.1 LoRA on `qwen_image_edit_2_1_local` (§6 Q4), a MOSS style LoRA on `moss_image_local` if one is on the machine), a 2509 LoRA on the 2.1 recipe (the amber line, the console's "lora key not loaded", the picture unchanged: the detection checked against the log), **a FLUX.1 LoRA from `flux/` on `flux2_klein_local` (the amber line once LR3's thresholds hold; the picture unchanged)**, a switched-off row, five rows, a name with a backslash, the via line and the exported PNG's chunk read back, **a LoRA on the int8_convrot files** (the unverified point); **MOSS Image Edit:** an edit of a selection with one picture, **one with two references (how the model takes "image 2" in the `Moss-Image-Edit` format, which puts no markers into the text: start with `image {n}`, keep it if the model follows it, else the wording that worked (the card says "explain the role of each image"); `refs.name` changed if needed; §7's unverified point, decided here, not asked)**, a Generate new, the seconds, the references' size against the output's (the Megapixels row's reach, §3.6); findings into `docs/RECIPES.md` and the manual's draft | `docs/measurements/lr9_<date>/summary.txt`, `recipes/moss_image_edit_local.json` (the names), `docs/RECIPES.md` | the live run is the test | every family's LoRA visibly changed the picture, or the reason is in the summary; the MOSS edit lands and the pictures' names are settled; a defect found means a fix session before the release | 0.5 + the user's time |
| **LR10** | **Docs and the hand-over** (§3.9): the manual, README, RECIPES.md, COMMANDS.md final, the CHANGELOG lines, CLAUDE.md item 50 and the "Where things stand" line, **`loras` in CLAUDE.md:819's gate list, `tools/run_gates.sh`'s header comment and `docs/TESTING.md`'s gate table**, the issue replies drafted (§6 Q3) | `docs/MANUAL.md`, `README.md`, `docs/RECIPES.md`, `docs/COMMANDS.md`, `CHANGELOG.md`, `CLAUDE.md`, `tools/run_gates.sh` (a comment), `docs/TESTING.md` | Light: `help` (the manual renders), `lint` | the texts in; the replies in chat for the user | 0.5 |

**Totals (inferred):** about 8.5-9 days plus the user's time at LR5 (the key, an import), LR8 (the checks; the update
itself only if a newer stable is wanted) and LR9 (the live runs). The order LR0 → LR1 → LR2 → LR3 → LR4 → LR6 → LR7 →
LR8 → LR9 → LR5 → LR10 keeps every session that needs the user (LR5, LR8, LR9) late and together; LR5 may move earlier
whenever the user has the key at hand; LR7 before LR5, since LR5 runs its variant live.

## 5. How it fits into 0.1.52 beside CorridorKey

- **One branch, one release.** Both plans build on `corridorkey` (cut from `main` = 0.1.51) and ship as 0.1.52 on the
  user's word (`PLAN_CORRIDORKEY.md` §4.10, §5's release block: the CHANGELOG section covering both, `package.json`,
  the full gate list on both backends with **`loras`** added, **`python tools/build_node.py --check` as a read-only
  check (the `node` gate's first half; no shipped file changed, so no build), README's and `docs/MCP.md`'s tool counts
  equal to `grep -c '^### \`' docs/COMMANDS.md`** (§3.8: the `.mcpb` test counts the bundle, nothing counts the prose),
  `npm run dist`, `dist:portable`, `dist:store`, the exe
  gates once on tiles and canvas, the Store notes covering 0.1.48-0.1.52, **no node build from either plan**,
  `corridorkey` merged into `main` as a fast-forward, main pushed, the tag `v0.1.52` on main, the chain of
  `docs/RELEASING.md`, then `main` merged into `wasm-kernels`). CorridorKey's Stop B decision (the hosting answer,
  Route B or the in-app route dormant) does not hold LoRAs or MOSS Image Edit back: they ship in 0.1.52 whichever way
  that goes, and the release block's text names what is in.
- **The order of the two plans' sessions on the branch** (recommended; the user picks the days): LR0-LR4 and LR6-LR7
  need no machine and no key and can go first, while Corridor's written answer is awaited; **LR8 (the ComfyUI update)
  before CorridorKey's I0a install** (pack A into `custom_nodes` after a core update, not before: a pack that breaks is
  then the pack's fault, not the update's; both need the user present and ComfyUI idle); LR9 right after LR8; I0a's code
  read (no machine) may sit anywhere; I0b and the engine's sessions after; LR5 whenever the key is typed; LR10 and I8
  before the release block. One agent at a time on the branch: `host.js` moves in both plans.
- **Files both plans touch** (every session commits sequentially; no parallel agents on these): `renderer/editor/host.js`
  (CorridorKey: `keyScreen` beside `realismWhole` 3425-3575, `keyEngine` wrappers at `helperCall` 4810, `freeHelpers`;
  LoRAs: the store beside the presets 1449-1462, `applyRecipe` 1673, `queueGenerate` 3990-4142, `viaLine` 237,
  `workflowInfo` 4243, `runProvider` 2041: different regions), `electron/main/settings.js` (CorridorKey adds
  `DEFAULTS.key`; LoRAs add no default, only a comment line), `renderer/commands.js` (`key_screen` against
  `set_generation` / `status` / `list_recipes` / `list_loras`), `renderer/shell.js` (the Key dialog's dispatch at 3175
  against `host.loras` at 3266 and the save path), `electron/main/assistant/policy.js` (RUNS against READS),
  `electron/main/main.js` and `electron/preload.js` (CorridorKey's `key*` IPC against `loras:header`),
  `docs/COMMANDS.md`, `README.md`, `docs/MCP.md` (the tool count: **COMMANDS.md's heading count at the commit**, 116 →
  117 → 118 in whichever order LR4 and I7 land, the core sub-count 96 → 97 → 98 with it; LR4's commit rewrites
  `PLAN_CORRIDORKEY.md`'s "117" to "+1 on what README says", §3.8), `CHANGELOG.md`, `CLAUDE.md` (item 49's and item 50's
  blocks, the "Where things stand" line), `docs/MANUAL.md`, `docs/BUGS.md`. `inpaint_worker.js` and every shipped editor
  file: neither plan. **CLAUDE.md departs from `PLAN_CORRIDORKEY.md` §4.10's one-place rule by one block:** the merge
  after 0.1.52 conflicts in item 49's block, item 50's block and the "Where things stand" line, all docs-only and
  resolved by hand as the 0.1.51 merge into `wasm-kernels` was.
- **The kernel branch:** `wasm-kernels` merges `main` after 0.1.52 (`host.js` read by hand: K0a's marks in `saveExport`,
  `keyScreen`, the LoRA regions). CI builds only `main`, tags and pull requests, so pushing `corridorkey` costs no build.
- **The user's machine between the plans:** LR8 changes the production ComfyUI (a core update); I0a adds a pack; LR9,
  I0a's reference keys and B0 / B5 queue prompts there. Every one of them with the user present and `/queue` checked.

## 6. Open questions for the user, each with a recommendation

Only what the code cannot answer. Where nothing is said by the session that needs it, the recommendation is taken and
the hand-over says so.

1. **The ai-toolkit MOSS edit LoRAs (before LR6).** `edit_format` sits on two encoder nodes and a Settings row writes
   one input, so the recipe fixes `Moss-Image-Edit` (chinoll's LoRA, Comfy's rehost). akhaliq's HQ and the CharRef LoRA
   need `ai-toolkit` on both: a second shipped recipe, or the user's own copy (*Edit in ComfyUI*, change both nodes,
   *Save as new recipe*; the manual says how)? *Recommended: one recipe in 0.1.52 and the manual's sentence.*
2. **The edit LoRA's download at LR8.** Claude downloads the 297 MB file into the production `models/loras/` with its
   sha256 checked (as the MOSS weights on 2026-10-22), or the user does? *Recommended: Claude, on the user's yes in chat
   at the time (a disk ask, said with the size).*
3. **The issues.** A short comment on #10 and #11 now ("on the list, ships with the next update"; drafted for the user)
   and the closing comment at the release, or one comment at the release? *Recommended: a short comment now, the user
   posts it.*
4. **The Qwen Image 2.1 LoRA for the live run (before LR9).** The user's `qwen/` folder holds 2509-era LoRAs (Relight,
   Lightning, the user's own trained on 2509, by their names); a 2.1 LoRA may have to be downloaded for the run
   (Comfy-Org's `Qwen-Image-2.1` `loras/` turbo LoRA, or one of Civitai's `Qwen 2.1` entries). *Recommended: Comfy-Org's,
   named with its size in chat before the download; the user's own `qwen/` LoRAs run too, as the amber line's live
   check.*

A fifth question arises only if a stable newer than v0.44.0 is out when LR8 starts: whether to take it (asked then, with
its pins diff; §3.7).

**Decided here, not asked** (§0 "Decided in this plan"): item 50; `ed.addSection` as the hook **and the section's place
right after Settings by a DOM move in app-only code** (the first draft asked this; the code answers it); **Comfy Cloud
without a listing takes the typed name with the note** (the main session's decision, §0; the first draft asked it
again); **the pictures' names in the MOSS edit prompt decided by LR9's run** (the first draft listed it here; no one can
answer it before the run); the LoRAs inside the result's `via`; a declared `loras.model` may read a MODEL; `list_loras`
as a core tool (the count as §3.8); the strength row's range; the relight recipes out of scope; the rows kept in the
store when a user recipe is removed; the Save as new recipe copy through the `from` field; no Civitai lookup; the eight
Settings rows of the MOSS edit recipe with the edit LoRA as a file combo (the missing-file refusal with the link) and
the Megapixels row's reach; the user's rows after the edit LoRA by declaration; `edit_format` fixed in the file.

## 7. Risks, and what changes the plan

- **A wrong-base LoRA is silent on the server.** Scumble cannot read ComfyUI's console; the hint is the only warning,
  and it is a hint: keys read only when the server URL names this machine (loopback or its own name, enforced in
  `host`, §3.4) **and** Settings › Helpers points at the ComfyUI models folder (the user's setup today; a RunPod user
  gets metadata and folder names only, so a local file of the same name never speaks for the server's). **FLUX.1 against
  FLUX.2 / Klein** rests on block counts and widths that LR3 reads from the user's files; until then the hint says
  "FLUX.1 or FLUX.2" and never matches, so the amber line cannot be wrong there, only absent. The manual says where the
  console's "lora key not loaded" line is. **Changes the plan** if LR9 shows the key table wrong for a family: the table
  is data in `loras.js`, fixed with the test's case.
- **The header answer's size.** A raw SDXL header (2,958 tensors) and a tag frequency of megabytes would pass any flat
  cap or be cut by it; the reduction in main (§3.4) keeps the IPC answer at a few KB whatever the file. The 16 MB read
  cap stays (ComfyUI's own endpoint stops at 1 MB).
- **LoRAs on the quantised files** (`*_int8_convrot`, the shipped Qwen 2.1, FLUX 3 Klein and MOSS defaults): unverified
  until LR9. If a LoRA does nothing there, the recipe's Model row offers the bf16 file and the recipe's description says
  which files take LoRAs; nothing else changes.
- **Names across servers.** The stored name is one server's spelling (`klein\x.safetensors`); another server (a RunPod
  with `/`) matches by normalised separators and the server's spelling goes out; a file absent there is refused before
  the run. The Settings rows' file combos have the same property today.
- **Comfy Cloud's lists.** The live `LoraLoaderModelOnly` combo omits catalog files (`moss_*`), and the account's
  imports are not in any list Scumble reads today: a Cloud run is never refused on a LoRA name (`docs/RECIPES.md:418`),
  and a wrong one ends with Comfy's message and `missingNote` (which names the chain's files too, since the splice
  comes before `checkModelFiles`, §3.5). The probe (LR5) decides the picker's source, not the splice: without a listing
  the row takes a typed name (the splice is the same code; a mistyped name fails on Comfy's side with its message and the
  note, nothing is paid for a run that never started).
- **The Cloud MOSS edit variant** is generated from a template whose two classes the fixture node list lacked; LR7 adds
  their specs so the checks see them, and LR5 runs the variant once. Should LR5 not run it (no key at hand), RECIPES.md
  says so, as it does for other recipes built from docs.
- **The pictures' names in the MOSS edit prompt** (`image {n}` in the `Moss-Image-Edit` format, which puts no markers
  into the text) are unverified until LR9's two-reference run; `refs.name` is one string in the recipe file, changed
  with the finding (RECIPES.md and the manual carry it).
- **`require(esm)` of a local file in main.** The SDK is required that way, a local ES module has not been; LR0 tries it
  once. On a refusal the CJS twin and the shared case file (`docs/TESTING.md:254`'s precedent) cost about half a day
  more at LR5.
- **The ComfyUI update's blast radius.** The update to v0.44.0 **has run** (2026-11-06 02:55, §0), with its frontend
  bump (1.55.18 → 1.57.6: Scumble's ComfyUI window shows that page) and its pins, but **its checks have not**: the 142
  `custom_nodes` entries' import failures (§3.7 step 3's order: the packs Scumble's recipes need, then the known
  breakers on a core bump, `ComfyUI-HotReloadHack` first), the InpaintCanvas node's hot reload, `/object_info`'s classes,
  one Klein run. They are LR8's first act once the user starts the server. For a further update the pins are shown
  before pip runs (from the installed file, against the tag `update.py` will take), `pip check` brackets it, the backup
  branch and the freeze allow a rollback, the script runs with its `nopause` argument from `update\`; Claude restarts
  nothing. A pack that breaks on the new core is reported to the user, not fixed in that session. **Never while a
  kernel-branch benchmark runs** (the user's rule): asked in chat before LR8 starts.
- **MOSS Image Edit below 0.43** stays a listed recipe with the readiness sentence (`needs`); the user's folder is at
  0.44.0 on disk, so on this machine the sentence goes once the server runs the new code; the live run (LR9) waits for
  LR8's checks.
- **The template's defaults** (CFG 4, 30 steps, SLG 0-1, the int8 SFT and w4a8 encoder on Comfy's side; the user's bf16
  SFT and int8 encoder here) against the re-packager's CFG 5: LR9 judges by eye; the Preset row can carry both as
  `moss_image_local`'s does.
- **The via text grows** with five rows (stems only; the full names in the log and the PNG chunk); the history row's
  `.ipc-hvia` span wraps. If it reads badly, "+ 5 LoRAs" alone in the via and the names in the log is the fallback
  (no shipped change either way).
- **The section's place.** It sits right after Settings by a DOM move in app-only code (§3.2), so no node build; should
  a later `inpaint_modal.js` gain the section natively, the move becomes a no-op. The one thing to watch: a plugin that
  itself moves or counts the Generate pane's `<details>` (none shipped does; the Boxes panel appends).
- **A sixth LoRA, a user with 1,201 files:** the cap is five by decision; the picker's search carries the rest.
- **Save to recipe after a run with LoRAs:** the ComfyUI window shows the recipe's graph (`r.prompt`), never the
  spliced copy, so the rows are not in the saved graph; a user who wants a LoRA in the recipe itself adds a Load LoRA
  node there, as today. Said in the manual.
- **The 8-slot cap is untouched**; MOSS Image Edit uses all eight, so a user's later rows there need the ComfyUI window.
- **Shared files with CorridorKey** (§5): sequential sessions, one agent on the branch at a time; the merge into
  `wasm-kernels` after 0.1.52 is read by hand.
- **Production machine.** LR5's import, LR8 and LR9 only with the user present; the gates run `--offline` with the queue
  stubbed; the research's reads of the user's ComfyUI were read-only and stay so (the header reader reads files, never
  writes; `custom_nodes` is not touched by this plan).
- **Unverified until the sessions run:** every timing; a LoRA on int8_convrot; the account-model route on Comfy Cloud;
  how the `Moss-Image-Edit` format names a second picture; whether Electron's main requires a local ES module; the
  frontend bump's effect on the ComfyUI window (the bump is on disk, the window not yet opened against it); the FLUX.1
  / FLUX.2 block counts and widths of the user's files; the running server's version (the folder says 0.44.0); the Cloud
  MOSS edit variant's run; who ran the 02:55 update and whether a "before" freeze was kept.

## 8. Sources (read 2026-11-06)

- The three research reports, uncommitted at the time of writing under `docs/research/issues10_11_2026-11-06/`
  (`lora_app.md`: Scumble's splice point, every recipe's MODEL path, the slot cap, persistence, the UI hooks, the
  tests; `lora_ecosystem.md`: ComfyUI's LoRA nodes and key maps per family, the silent failures, the user's folder,
  fal / Replicate / WaveSpeed / Comfy Cloud; `moss_edit.md`: what "MOSS Image Edit" is, the template, the node, the
  v0.42.4 gap, the hosts). Their scratch files (safetensors headers, fal's OpenAPI, the template) stay in the planning
  session's scratchpad.
- GitHub issues DenRakEiw/scumble#10 and #11 (data; `gh issue view`).
- Scumble at `a86b94e` (the worktree): the anchors named above, re-read on this branch; `docs/PLAN_CORRIDORKEY.md`
  (§4.10 the branch and the release, §5 the rules and the release block, §6 the shape of the answers), `docs/RECIPES.md`
  (41-44, 124-127, 187-200, 279-295, 329-331, 396-421), `docs/MANUAL.md:146-173`, `docs/TESTING.md:153, 254`,
  `tools/build_node.py:39-46, 106-121`.
- The user's ComfyUI, read-only: `ComfyUI/server.py:413-419, 749-770, 849`, `comfyui_version.py` (0.42.4 at the
  research; **0.44.0 at the evening re-read**), `update/update.py:60-152`, `update/update_comfyui_stable.bat`,
  `update/current_requirements.txt`, `models/loras/` (names only), `custom_nodes/` (names only; 142 entries); its
  `nodes.py`, `comfy/lora.py`, `folder_paths.py`, `execution.py` as the research cites them. **The evening re-read**
  (2026-11-06, after the critics): `comfyui_version.py`, `git log -1` / `git describe --tags` / `git branch --list
  'backup_branch*'` / `git stash list` in `ComfyUI/` (read-only commands; nothing in `custom_nodes` touched),
  `ComfyUI/requirements.txt`, `comfy_extras/nodes_moss_image.py:102`, `models/loras` (no `moss*`); `curl
  /system_stats` refused (the server down). The research's template copy
  (`scratchpad/iss_lora_ecosystem/tpl/image_moss_image_edit.json`: `frontendVersion` 1.57.1, `widgets_values_named` on
  15 nodes). The worktree anchors the critics cited, read again: `recipes.js:246, 594-654, 720-746, 900-918`,
  `recipes_test.js:805-870`, `comfycloud.js:300-325, 355-378, 392-400, 588-610, 750-790`, `host.js:826-832, 1356-1364,
  1572-1580, 1944-1950, 2100-2136, 2316-2322, 2582-2640, 4085-4090`, `inpaint_modal.js:355-372, 1081-1091`,
  `plugins.js:922-932`, `shell.js:162-171, 3316-3322`, `main.js:1032-1050`, `comfyview.js:505-512`,
  `onnx/models.js:76-86`, `tools/cloud_recipes.js:68-95`, `tools/mcpb_test.js:42-47`, `tools/assistant_test.js:680-684`,
  `tools/run_gates.sh:20-30, 140-144`, `docs/TESTING.md:150-158`, `CLAUDE.md:819`, `README.md:83, 303`,
  `docs/MCP.md:306`, `PLAN_CORRIDORKEY.md:829-833, 883-888, 1026-1038`, the fixture `tools/refs/comfy_templates/
  object_info.json` (93 classes) and the fifteen exports under `tools/refs/comfy_cloud/`.
- `@comfyorg/sdk` 0.5.0 (`F:/canvas/node_modules/@comfyorg/sdk/dist/low/generated/types.gen.d.ts:242-506`, the routes).
- Comfy-Org/workflow_templates `image_moss_image_edit.json` and `index.json`; Comfy-Org/MOSS-Image (the LoRA's commit,
  the card); chinoll/Moss-Image-Edit; Comfy-Org/ComfyUI PRs #17296 and #17320, releases v0.43.0 (2026-10-27) and
  v0.44.0 (2026-11-04), the `v0.42.4...v0.43.0` compare of `requirements.txt`; Comfy Cloud's live catalog through its
  MCP server (`get_node`, `search_models`), as the research read them.
