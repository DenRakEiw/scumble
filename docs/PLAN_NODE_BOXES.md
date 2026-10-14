# Edit-box prompting in the Inpaint Canvas node (the node update after 0.3.4)

The user, 2026-10-14: "lass uns ein update der inpaint canvas node machen mit Edit-Box-Prompting", then "mache einen
umsetzungsplan, dann machen wir einen clear und du kannst es heute nacht bauen, ohne pausen nur compress falls der
kontext voll wird". This plan is written for that night build: one session after `/clear` builds B0 to B6 in order,
**without pausing between steps**, and lets the context compact instead of stopping. Nobody is there to ask: the
decisions are taken in §2 and listed for the morning. The research is a workflow of five readers (2026-10-14, run
`wf_9d6e6840-789`); their maps, with every anchor, are in `dist/plans/node_boxes_maps.md` (not in git; grep the part a
step needs). Two critics checked this plan against the code the same evening (run `wf_bc5bb676-78e`, 31 points, all
worked in).

## 0. The goal in one paragraph

Today the node has no box prompting (the app has it: `plugins/boxes`, `renderer/editor/boxes.js`,
`electron/main/providers/boxes.js`, docs/PLAN_BOXES.md). ComfyUI core 0.39.0 has *Create Bounding Boxes* and the
partner node *Flux 3 Image* with a `bounding_boxes` input, but that input writes **new-image rows only**
(`{id: "box_N", bbox, desc}`, `comfy_api_nodes/nodes_bfl.py:1629-1643`): no Keep, Move, Remove or From, no
`src_bbox` / `tgt_bbox`, no `ref_image_k`. The update gives the node what core lacks: the user draws boxes in the
node's editor (the same tool X as in Scumble), and the node writes FLUX 3's **edit rows and caption** into a new STRING
output `box_prompt` for the prompt of any FLUX 3 node (core *Flux 3 Image*, the user's own *Flux 3 Image (API)*), plus
a core-shaped ARRAY output `elements` (New and Text boxes) for *Flux 3 Image*'s `bounding_boxes`, *Create Bounding
Boxes* (a preview) and *Build JSON Prompt (Ideogram)*.

## 1. Rules for the night (re-read after every compaction)

- **After every compaction, before the next command:** re-read §1, §5, §7 and the last §9 entry of this file, and run
  `git -C F:/canvas/dist/node_boxes log --oneline -5` and `git -C F:/canvas log --oneline -5` to see where the night
  stands.
- **Nothing is written into the live node folder** `F:\Comfyui\ComfyUI_windows_portable_nvidia\ComfyUI\custom_nodes\
  ComfyUI-InpaintCanvas` (any write there, `.git` and `__pycache__` included, hot-reloads the node in the user's
  production ComfyUI; a RETURN_TYPES change also needs a restart, which is the user's call). All node work happens in
  the **clone** `F:/canvas/dist/node_boxes` (B0). Reading files in the live folder is fine; no git command there, none
  in `F:/canvas/dist/node_wt` either (its gitdir is in the live `.git`).
- **Forbidden tonight, by name:** `python tools/build_node.py` without `--node F:/canvas/dist/node_boxes` (its default
  is the live folder), `npm run build-node` (the same bare build), the build lines of `docs/BUILD_NODE.md` (:9, :132),
  the gates `node` and `nodecopy` (they read the live folder and go red by design from B2 on, since Scumble's editor
  then names outputs and host members the live node lacks), `comfy_cli zip_files`, starting or importing the clone's
  `mcp/inpaint_canvas_mcp.py` (it talks to 8188; check it with
  `python -B -c "import ast,sys; ast.parse(open(sys.argv[1],encoding='utf-8').read())" F:/canvas/dist/node_boxes/mcp/inpaint_canvas_mcp.py`
  and a grep of its `@mcp.tool()` count), and this session's `mcp__inpaint-canvas__*` tools (the user's ComfyUI) and
  `mcp__scumble__*` / `mcp__Scumble__*` tools (the user's own Scumble and profile).
- No push (the clone's push URL is disabled in §5), no version bump in the node's `pyproject.toml` (a push of it
  publishes to the Comfy Registry), no paid run, no ComfyUI restart, no call to port 8188 beyond a read of `/queue` or
  `/system_stats`. Gates run `--offline`.
- **Commits.** Scumble on `main`, local only, as DenRakEiw (`git -c user.name=DenRakEiw -c
  user.email=89697885+DenRakEiw@users.noreply.github.com commit -F <file>`, no trailer). **Stage only the step's files
  by name**, never `git add -A` / `git add .` / `git commit -a` in Scumble; before each commit `git diff --cached
  --name-only` lists only those files. Never staged: `docs/TUTORIAL.md`, `docs/images/video/`, `.claude/`, `scratch/`,
  `snap/`, `packaging/`, `genesis-magma-gt/`, `build/icon-400.png`, `run_dev.cmd`. B0's commit also takes this plan and
  CLAUDE.md (tonight's block); each later step stages the plan again for its §9 line. Each commit message is written
  with the Write tool into a **new** scratchpad file (a new name per commit; a reused file gives the old message) and
  passed with `-F`; no `-m` with backticks, no heredoc (CLAUDE.md "Tooling" traps). The clone may use
  `git -C F:/canvas/dist/node_boxes add -A` (its `.gitignore` covers `__pycache__`); its branch is `boxes`.
- **No pause between steps.** Finish a step (tests green, commit, a paragraph in §9 "As built"), then start the next.
  When the context fills, let it compact; never `/clear`.
- **Usage.** Load the tool once (ToolSearch `select:mcp__ccd_session_mgmt__get_usage`, a deferred tool) and read it
  between steps and before B6's workflow. **Weekly above 99 %** (the user's rule): finish the step in hand, commit,
  write the hand-over, stop. **5-hour window above 85 %:** commit what passes (a WIP commit in the clone is fine,
  Scumble only with green tests), write the §9 line, start a background Bash `sleep <seconds until its reset + 300>`
  with `run_in_background: true` and end the turn; when it wakes you, read the usage again and go on. If `plan` is
  "unavailable", go on and read it after the next step.
- Scumble's own behaviour must not change: the app keeps its Boxes plugin as the owner of boxes in the app; the shared
  code moves under `renderer/editor/` and the plugin imports it. The app gates stay green (§5 lists them).
- Tests by risk (CLAUDE.md "Working rules"): **normal** tier (tools and features); the Python writer and the docs are
  light. The shared `getValue()` / `setValue()` change is guarded by a host flag (app side unchanged), and the
  `document` gate runs with B4 and B6 to prove it.
- Files with non-ASCII or escapes: build edge strings in code (`String.fromCharCode(0xD83D, 0xDE00)` in JS,
  `chr(0x1F600)` in Python), never as `\u` escapes typed through the Write tool; after a Write of a `.js` / `.py`,
  `grep -nP "[^\x00-\x7F]" <file>` against what was meant. Python files are opened with `encoding="utf-8"` (this
  Python defaults to cp1252). Patch scripts write with `newline=chr(10)`.
- Ultracode is on: B6 is a review workflow (finders by area, each finding verified by a skeptic).

## 2. Decisions taken for tonight (the user can change them in the morning)

| # | Question | Decision tonight | Why |
|---|---|---|---|
| D1 | Who writes the rows | **nodes.py (Python)**, in `run()`, next to the crop and the batch | Only run() knows the exact frame (padding, auto context, `_fit_span_to_multiple`), the batch as built (Original or not, a skipped reference) and the reference fit (pad / crop / stretch). The editor's `cropRect()` differs at target_size 0. |
| D2 | Outputs | Two **tail outputs** after `setting_8`: `box_prompt` (STRING) and `elements` (ARRAY); `prompt` unchanged | Links are by index: only appending keeps saved workflows. The plain `prompt` keeps feeding non-FLUX chains without JSON in it. |
| D3 | `box_prompt` without boxes | The plain prompt (boxes off, none, or none left) | Wiring `box_prompt` is then always safe. **As built (B6 review):** only while the switch is off; with it on and no box the selection goes as one box (D8), so the docs say "switch it off before box_prompt feeds a model that reads no boxes". |
| D4 | `elements` content | New and Text boxes of the frame in core's shape (`{type, bbox, text?, desc}`, no id); `[]` when boxes are off | Core renames ids and knows no edit kinds; Keep / Move / Remove / From live only in `box_prompt`. |
| D5 | Box UI in the node | A **core module** `renderer/editor/inpaint_boxes.js`, active only when the host member `boxesInEditor` is true (node true, app false), reusing the plugin's tool and model code moved under `renderer/editor/` | One tool and one model for both hosts; the app keeps its plugin; no node-owned UI module. |
| D6 | Persistence | `editor.pluginData.boxes` (the app's shape `{version: 1, boxes: [...]}`), put into `getValue()` / read in `setValue()` **only when `host.boxesInEditor`** | The app's `.scumble` and autosave stay as they are; the node's workflow keeps the boxes. |
| D7 | Prompt-time payload | `serializeForPrompt()` adds `boxes`, `referenceIds` and `selectionBoxId` when `gen.boxes` is on (both hosts; `boxes` only when the document holds some) | nodes.py ignores unknown keys; the app's local recipes do not wire `box_prompt`, so nothing changes there. |
| D8 | The selection as a box (S1) | nodes.py builds it from the exact selection bounds (`_selection_bbox(mask, 0)`) as one New box with the prompt as its desc, **only when the switch is on, the document holds no box (`boxes` absent or empty) and there is a selection**; its id is the editor's `selectionBoxId` (`${idWords(foldDesc(prompt)) || "edit"}_1`, renderer/editor/boxes.js:120-121) when it matches BOX_ID, else `edit_1` | The app's S1 rule (host.js:1840-1842); boxes the crop left out are no reason for it. |
| D9 | A box that cannot be placed | Dropped with a **note**; run() **never raises from the box path** (a box failing the check is dropped with its error text; any other exception gives the plain prompt, `[]` and the note "Boxes were not written: <error>"); notes go back as `ui: {inpaint_boxes: [...]}` and show as a warn line in the editor | A raise would fail the whole queued prompt; the app refuses before paying, the node cannot. |
| D10 | Wording and numbers | The app's: `text reading "..."`, JS rounding (`floor(v*1000+0.5)`), compact JSON (`separators=(",", ":")`, `ensure_ascii=False`), the app's key order | The Python writer is held to vectors made from `electron/main/providers/boxes.js`. |
| D11 | Aspect presets | Not tonight: the node does not widen the crop to FLUX 3's presets; the docs say `aspect_ratio` "auto" | Unverified what "auto" does with a non-preset aspect (a live check). |
| D12 | Node version | No bump tonight; 0.3.5 or 0.4.0 is the user's pick in the morning | The user said "no 0.3.5 yet" on 2026-10-13; a bump publishes. |

## 3. What exists (short; the maps have the rest)

- **App, data:** `ed.pluginData.boxes = { version: 1, boxes: [{ id, kind, rect, src, layer, desc, text, colour }] }`,
  image pixels `[l, t, r, b]` (r, b exclusive; `text` null on boxes that are not Text boxes), written through
  `scumble.documents.data(doc).set(.., { undo })` = `ed.pushUndo({ kind: "data", label })` + merge + `host.changed`
  (`renderer/plugins.js:705-717`). The undo kind `data` and `pluginDataCopy` are core
  (`inpaint_canvas.js:14100, 14338-14342, 5400-5423`) and ship in the node. `pluginData` is not in `getValue()` (the
  app saves it beside: `host.js:179, 4129`) and is never initialised in the node (undefined until a write).
- **App, plugin:** `plugins/boxes/main.js` (normalise, add / set / remove / clear, fromSelection, cropCheck, the
  geometry corner map `main.js:301-317`, FIELDS, the six commands, the panel; it uses `scumble.host.cropFrame /
  boxSwitch / recipe`, `doc.layer(key)` = the app's `findLayer`, `doc.selection({box: true})`), `tool.js`
  (`makeTool(scumble, api)`: tool X, handles, D, Alt-cycle, the double-click describe dialog `tool.js:78-132`, the
  overlay with colours and tags, its icon `tool.js:190`; `scumble` only in `closeEditor` `tool.js:86`, everything else
  through the per-call `doc` (a plugins.js Document: id, width, height, loaded, status(text, kind), layers(), layer(key),
  editor; `plugins.js:52-75`) and `api`), `format.js` (pure: grid, rowsFlux3, rowsText, captionFlux3, whereWords,
  wayWords, clipboardText; held equal to main's writer by `tools/boxes_test.js` §10). `renderer/editor/boxes.js` is
  pure (BOX_ID, idWords, foldDesc, toFrame, selectionBox, pluginBoxes, smallBoxes) and not in the node build.
- **App, how a run measures** (`renderer/editor/boxes.js:159-209` pluginBoxes): keep, move and remove measure `src`
  against the frame ("Box <id>: its source lies outside the crop, so the box was not sent."), then every kind measures
  `rect` ("Box <id> lies outside the crop and was not sent."); a From box's `src` is `toFrame(src, layer frame
  {x: l.x, y: l.y, w: l.w, h: l.h})` (`host.js:1772`, `boxes.js:180`), fractions of the layer as shown.
- **App, writer:** `electron/main/providers/boxes.js` (CommonJS; requires only `./refs`): `checkBoxes` (throws),
  `grid`, `rowsFlux3`, `captionFlux3` (S3e place words), `applyBoxes` = caption + " " + `JSON.stringify(rows)`,
  `captionIdeogram4`. Rows (key order fixed): new `{id, from: null, src_bbox: null, tgt_bbox, desc}`; keep `{id, from:
  "ref_image_0", src_bbox: g(src), tgt_bbox: g(src), desc}`; move `{.., src_bbox: g(src), tgt_bbox: g(rect)}`; remove
  `{.., tgt_bbox: null}`; from `{id, from: "ref_image_k", src_bbox: g(src in that picture), tgt_bbox: g(rect), desc}`; a
  new image `{id, bbox, desc}`. Grid `[top, left, bottom, right]`, 0..1000, half up, an empty box widened to one cell.
- **Node:** `nodes.py` `InpaintCanvas` (`:598`), 13 fixed outputs + 8 `*` setting slots (`:627-643`), the frame
  `x0..y1` (`:689-713`), the batch `[crop, crop_orig?, refs fitted to the crop]` (`:719-757`; the Original only with a
  selection, fill != none, withOriginal, not refine; a reference that fails to load is skipped), `stitch_info.bbox`
  (`:763`), `_fit_image` pad / crop / stretch (`:171-189`; crop through `comfy.utils.common_upscale(.., crop="center")`),
  the expand path (`:779-794`). The node-owned `js/inpaint_node.js` has the tail-output machinery (`TAIL_OUTPUTS` from
  the editor, `syncSettingOutputs`, the queuePrompt remap to backend slot 13 + 8 + i, `:30-62, 179-191`; the remap uses
  `app.graph.getNodeById(+v[0])`, which fails for a canvas in a subgraph) and the canvas_state wrappers (`:68-74`);
  `js/host.js` answers `boxSwitch()` null (`:168`), `refTokens` false, the plugin hooks as no-ops (`:193-198`), and its
  `changed` only marks the canvas dirty (`:95-98`). `TAIL_OUTPUTS = []` is in `renderer/editor/inpaint_canvas.js:429`;
  the core Boxes row (`inpaint_modal.js:975-993`, `syncBoxesRow` `inpaint_canvas.js:23885`) shows when
  `host.boxSwitch(ed).takes`. The node's `CLAUDE.md` is gitignored (not in a clone).
- **ComfyUI core:** `Flux3ImageNode` images Autogrow `images.image_1..image_10` flattened in order (max 10, each >= 256
  px a side), prompt + rows capped at 15000 characters, `aspect_ratio` "auto" follows image 1; `bounding_boxes` ARRAY
  (type string `"ARRAY"`; a classic node's `RETURN_TYPES = ("ARRAY",)` links to it and to *Create Bounding Boxes*'
  MultiType `bboxes`). Core elements: `{type: "obj" | "text", bbox: [ymin, xmin, ymax, xmax], text (text only), desc,
  color_palette?}` (`comfy_extras/nodes_bounding_boxes.py:277-306`). With `crop_image` wired whole into `image_1`,
  batch index k is `ref_image_k` and "image k+1" in prose.
- **Build and tests:** `tools/build_node.py` (`FILES` `:39-46`, `NODE_OWN` `:48`, `--node PATH`, `--check`: parse,
  named imports, `\bhost\.(\w+)` in every built module's **full text, comments included**, must exist in both hosts,
  and a module that uses `host.` must import it), `tools/node_test.py --node PATH` (a hidden Electron window over
  stand-ins; `tools/node_test/app.js:7` and `api.js:38` do not record queued prompts), the node's `tests/test_paths.py`
  (stubs for folder_paths, comfy.utils with a plain bilinear `common_upscale` that **ignores `crop`**, an empty
  `GraphBuilder`, comfy_execution, server; loads nodes.py by file spec, no package; 32 tests, 1 skipped).

## 4. Contracts (what every step builds against)

**canvas_state** (serializeForPrompt, D7), when `gen.boxes` is true:

```
"selectionBoxId": "red_door_1",          // idWords(foldDesc(prompt)) || "edit", then "_1"
"referenceIds": ["L..", "L.."],          // the layer ids of `references`, same order
"referenceLabels": ["img1", "img2"],     // (B6) each reference's @img label: nodes.py writes @imgN as "image n"
"boxes": [{ "id": "red_scarf_1", "kind": "new|keep|move|remove|from",
            "rect": [l,t,r,b], "src": [l,t,r,b] | [fl,ft,fr,fb], "ref": 0,
            "desc": "...", "text": "..." }]   // only when the document holds boxes
```
`rect` in document pixels for every kind. `src` only for kinds other than new: keep / move / remove in document pixels;
**from: fractions 0..1 of its layer's frame `{x: l.x, y: l.y, w: l.w, h: l.h}`** (`toFrame(src, frame)`,
`[0, 0, 1, 1]` without a src; a src that toFrame turns to null leaves the box out). `ref` (from only) = the index into
this payload's `references`; a From box whose layer is not among them is left out, its note appended to the "Queued
crop ..." line (kind warn; serializeForPrompt writes that line last, `inpaint_canvas.js:24479-24480`). `text` only on a
new box and only when not null. `desc` folded and cut at 400 (`DESC_MAX`).

**nodes.py** (B2), inside `run()` after the frame and the batch, never raising (D9):
- Frame `F = (x0, y0, x1 - x0, y1 - y0)` (the same as `stitch_info.bbox`). Measure as pluginBoxes does, in this order:
  a From box's `src` through its picture and fit (below); keep, move and remove: `src` against F (dropped with the
  app's "its source lies outside the crop" note); every kind: `rect` against F (dropped with "lies outside the crop and
  was not sent"); a side under 1/1000 is dropped (as `toFrame`). Then the grid with `floor(v * 1000 + 0.5)`.
- Picture names from the batch actually built: the crop `ref_image_0`; the untouched crop `ref_image_1` when it went;
  reference j (0-based among the **loaded** references, by their place in `references`) `ref_image_{1 + o + j}`. A From
  box whose reference was skipped is dropped with a note. With fill on, a Keep / Move / Remove source that overlaps the
  selection gets a note (that part of `ref_image_0` is filled).
- A From box's src: `src_px = fraction * (w, h)` of the **loaded** picture (its array's width and height, kept per
  loaded reference in the loop), then the fit to the crop size `W x H`:
  **stretch** `x' = x * W / w`, `y' = y * H / h`.
  **pad** (identity when `w == W and h == H`): `s = min(W / w, H / h)`; `nw = max(1, int(round(w * s)))`, `nh` likewise;
  `x' = x * nw / w + (W - nw) // 2`, `y' = y * nh / h + (H - nh) // 2`.
  **crop** (identity when the sizes are equal), as `comfy.utils.common_upscale` centre: `oa = w / h`, `na = W / H`;
  `cx = round((w - w * (na / oa)) / 2) if oa > na else 0`; `cy = round((h - h * (oa / na)) / 2) if oa < na else 0`;
  `x' = (x - cx) * W / (w - 2 * cx)`, `y' = (y - cy) * H / (h - 2 * cy)`; clamped to the picture, dropped with a note
  when nothing is left. Then fractions of `W x H`, then the grid. (Check these against `_fit_image` and
  `comfy/utils.py:1113-1124` before coding; the test stub's `common_upscale` ignores `crop`, so tests assert rows from
  these formulas, never pixels of a crop-fitted reference.)
- `box_prompt` = the app's caption + " " + `json.dumps(rows, separators=(",", ":"), ensure_ascii=False)`; the plain
  prompt when the switch is off, no box came, or none is left. `elements` = New and Text boxes in core's shape (D4),
  `[]` otherwise.
- Notes: short sentences, returned as `ui: {"inpaint_boxes": notes}` (with or without `expand`); a prompt + rows over
  15000 characters is a note too (core *Flux 3 Image* refuses it).
- Outputs appended in this order: `box_prompt` (`"STRING"`), `elements` (`"ARRAY"`), with `RETURN_NAMES` and
  `OUTPUT_TOOLTIPS`; `renderer/editor/inpaint_canvas.js:429` `TAIL_OUTPUTS` lists them in the same order with labels.
  An ARRAY of dicts is safe on the expand path (`is_link()` only takes a `[str, number]` pair).

**Vectors** (B0): `tools/boxes_vectors.json`, written by `node tools/boxes_vectors.js` from
`electron/main/providers/boxes.js`: grid edge cases incl. exact .5; each row kind; the text rows; `captionFlux3` cases
incl. `whereWords` / `wayWords` / place-only / the "In <ref_image_0>," opener / the closing sentence; `applyBoxes` full
prompts; the elements from `captionIdeogram4` on requests with `kind: "text"` only (New and Text boxes, so they match
D4), reshaped to core's element shape; `idWords` cases (if the editor's id is not sent, Python never needs it). A copy
goes into the clone as `tests/boxes_vectors.json`; `boxes_test.js` checks the file equals a fresh run, and B6 checks
`cmp F:/canvas/tools/boxes_vectors.json F:/canvas/dist/node_boxes/tests/boxes_vectors.json` (copy and commit again
whenever a step regenerates them).

## 5. Commands

The clone (B0; absolute paths, no `cd`):
```
git clone --no-hardlinks "F:/Comfyui/ComfyUI_windows_portable_nvidia/ComfyUI/custom_nodes/ComfyUI-InpaintCanvas" F:/canvas/dist/node_boxes
git -C F:/canvas/dist/node_boxes remote set-url origin https://github.com/DenRakEiw/ComfyUI-InpaintCanvas.git
git -C F:/canvas/dist/node_boxes remote set-url --push origin no-push-tonight
git -C F:/canvas/dist/node_boxes checkout -b boxes
```
`git clone` from the local path only reads the live repo. **If `F:/canvas/dist/node_boxes` already exists, never delete
or re-clone it**: it holds the night's commits; go on on its branch `boxes`.

The node's checks (foreground, `timeout: 300000`):
```
python tools/build_node.py --node F:/canvas/dist/node_boxes
python tools/build_node.py --node F:/canvas/dist/node_boxes --check
python tools/node_test.py --node F:/canvas/dist/node_boxes
PYTHONDONTWRITEBYTECODE=1 python -B -m unittest discover -s F:/canvas/dist/node_boxes/tests -v
```
Build into the clone from a **committed** Scumble state (`build_node.py` marks "+local changes" otherwise).

The app gates: each `bash tools/run_gates.sh ...` with the Bash tool's `run_in_background: true`, **one run at a time**
(each closes whatever listens on 9555), each run with its own label; read
`F:/canvas/dist/gates/gates/<label>/summary.txt` (ALL PASS / SOME FAILED) and only a failing gate's log; re-run a
failing step listed in docs/TESTING.md "Known flakes" before believing it; if a call was cut off, run
`SCUMBLE_CDP_PORT=9555 python tools/close_app.py` before the next run, and if a background chain is stopped, stop its
`bash.exe` / `timeout.exe` / `python.exe` by command line (CLAUDE.md's TaskStop trap).
- B3: `bash tools/run_gates.sh nb3 --offline --tiles on boxes commands lint types`, then
  `bash tools/run_gates.sh nb3c --offline --tiles off boxes`.
- B4: `bash tools/run_gates.sh nb4 --offline --tiles on boxes editor commands generate document lint types`, then
  `bash tools/run_gates.sh nb4c --offline --tiles off boxes`.
- B6: the B4 lists as `nb6` / `nb6c`.

## 6. Steps

### B0: the clone, the baseline, the vectors (light)
1. §5's clone (first, while the user may still be at the screen: the night's first command of each kind may ask for a
   permission). The baseline: build into the clone, `--check` ok, node_test PASS, the unittest 32 OK (1 skipped).
2. `tools/boxes_vectors.js` (plain Node, requires `../electron/main/providers/boxes.js`) writes
   `tools/boxes_vectors.json` (§4); `tools/boxes_test.js` gains a check that the file equals a fresh run. Copy it to
   the clone's `tests/boxes_vectors.json`.
3. Commit Scumble (the script, the JSON, the test line, this plan, CLAUDE.md's block) and the clone (the JSON).

### B1: the Python writer (light)
1. The clone's `boxes_rows.py` beside `nodes.py`. Pure Python, no torch: `check_boxes` (the app's texts), `grid` (D10),
   `rows_flux3(boxes, names)` for an edit, `rows_text` for a new image, `caption_flux3` (the S3e sentences: `clause_of`,
   VERB with `re.ASCII`, `where_words`, `way_words`, place-only, the opener, the closing sentence, the stop),
   `apply_boxes`, `elements_core`. Port line by line from `electron/main/providers/boxes.js`; §7's traps.
2. The import in nodes.py: `try: from .boxes_rows import <names>` / `except ImportError:` load it by file, as the tests
   load nodes.py (`spec = importlib.util.spec_from_file_location("inpaint_canvas_boxes_rows",
   os.path.join(os.path.dirname(os.path.abspath(__file__)), "boxes_rows.py"))`, `mod =
   importlib.util.module_from_spec(spec)`, `spec.loader.exec_module(mod)`, then bind the names). A plain `import
   boxes_rows` fallback is wrong (it needs the cwd, and could pick up another node's module).
3. `tests/test_boxes.py`: `import test_paths as tp; nodes = tp.nodes` (one stub install, the same DIRS; never import a
   TestCase from test_paths, or it is collected twice); loads boxes_rows by path the same way; finds its files from
   `__file__`; opens the vectors with `encoding="utf-8"`. Every vector, plus Python-only cases (rounding at .5, compact
   JSON, non-ASCII, a 400-character desc with an astral character at the cut).
4. Commit the clone.

### B2: nodes.py (normal)
1. In `run()`: read `state.get("boxes")`, `referenceIds`, `selectionBoxId` (absent: nothing changes); S1 only as D8
   says (a list whose boxes are all dropped gives notes and the plain prompt, never S1); measure, name and map (§4);
   call the writer inside one guard (D9); the two outputs; the notes in `ui`. Keep `IS_CHANGED`, the expand path and
   every existing output as they are.
2. `RETURN_TYPES` / `RETURN_NAMES` / `OUTPUT_TOOLTIPS` appended (D2). Scumble: `renderer/editor/inpaint_canvas.js:429`
   `TAIL_OUTPUTS` with the same two names, types and short labels; the comment that says it is empty updated.
3. `tests/test_boxes.py` gains run() cases on the stubs (a temp input folder with real PNGs): each kind's rows; the
   Original on and off; a reference that fails to load; pad, crop and stretch for a From box (rows from §4's formulas);
   target_size 0 with `multiple_of`; no selection; boxes off (plain prompt, `[]`); S1 (with and without
   `selectionBoxId`; not when all boxes are dropped); a box outside the frame (a note); the 15000 note; a malformed box
   (dropped, a note) and a writer exception (plain prompt, `[]`, the note). For the expand case patch `nodes.GraphBuilder`
   with a small fake (`node()` records, `finalize()` returns `{}`) and assert `ui.inpaint_boxes` beside `expand`. Take
   the frame from the returned `stitch_info`'s bbox in every case, never assume the whole picture.
4. Commit Scumble (TAIL_OUTPUTS), build into the clone, `--check`, node_test, unittest; commit the clone.

### B3: the shared JS (normal; the app must not change)
1. Move with `git mv plugins/boxes/format.js renderer/editor/boxes_format.js` and `git mv plugins/boxes/tool.js
   renderer/editor/boxes_tool.js`, then change them with Edit (their UI strings hold literal non-ASCII). tool.js becomes
   `makeTool(env, api)` with `env = { docById(id) }` (its only `scumble` use, `tool.js:86`); the caller keeps passing a
   doc adapter per call. Extract the plugin's pure model into `renderer/editor/boxes_model.js`: normalise (the id rules,
   kinds, src / layer / text / colour rules), add / set / remove / clear as functions over a list, fromSelection's box,
   cropCheck, the geometry corner map as `mapBox(rect, m)` (`main.js:305-316`), FIELDS, the warning texts; everything
   app-specific comes in as arguments (frame, selection bounds, a `findReference(key)` function, the prompt).
   `plugins/boxes/main.js` imports all three from `/editor/...` (as it imports `/editor/boxes.js` today) and passes the
   app's pieces. **None of the shared files may contain the text `host.`, comments included** (`--check` counts it as a
   host member). No page-level side effects at import (ComfyUI imports every js file of the node).
2. `tools/build_node.py` `FILES` += `boxes.js`, `boxes_format.js`, `boxes_tool.js`, `boxes_model.js`;
   `docs/BUILD_NODE.md`'s table.
3. Tests: `node tools/boxes_test.js` (144 + the vectors check; its format import path), the B3 gate runs (§5). Build
   into the clone, `--check`, node_test.
4. Commit Scumble (stage the moved files and the plugin by name), then the clone's build.

### B4: the boxes in the node's editor (normal)
1. `renderer/editor/inpaint_boxes.js` (in `FILES`): the core owner of boxes when `host.boxesInEditor` is true.
   - **Store:** `editor.pluginData ||= {}` before every read and write; `pluginData.boxes` (D6); one
     `pushUndo({ kind: "data", label })` per change (one per gesture, as the plugin). A `refresh()` (re-render the panel,
     `editor.syncBoxesRow()`, draw), which the core calls from `notifyChanged` when `host.boxesInEditor`
     (`inpaint_canvas.js:24057`), so a write, an undo or redo of a `data` or geometry step and `setValue` all refresh it.
   - **Tool:** add `boxes` to `ICONS` in inpaint_canvas.js with the inner markup of tool.js's icon
     (`<rect x="3" y="5" width="11" height="9" rx="1"/><rect x="10" y="10" width="11" height="9" rx="1"
     stroke-dasharray="3 2"/>`), then `if (host.boxesInEditor) addTool("boxes", "Boxes (X): ...")` next to the lights
     tool (`inpaint_modal.js:305`). Route events to the core tool beside each plugin hook, only while
     `host.boxesInEditor` and `this.tool === "boxes"`: pointer before `host.pluginPointer` at `:6027` (down: set
     `this.pointer = { kind: "boxes" }` and return), `:6419` (move: drag and hover) and `:6644` (up when
     `p.kind === "boxes"`); keys before `host.pluginKey` at `:3046` and `:3509` (Escape) and `:3622` (every single key
     after the Canvas tool's X: X selects the tool from any tool; D, Delete / Backspace, the arrows and Escape go to the
     tool's onKey while it is active and return when it answers true, so D never becomes the deselect tool and Delete
     never clears pixels or a layer); `onDeselect` where `host.toolChanged` is called (`:3438`) when the previous tool
     was "boxes"; the overlay `tool.draw(doc, ctx, { scale, dpr, angle, active })` at both `:4658` and `:4662` (inside
     and outside the tilt branch). Event shapes exactly as `renderer/plugins.js:561-626` (x, y, shift, alt, ctrl, raw /
     key, lower, shift, raw). The doc adapter: id, loaded, width, height, draw(), status(text, kind), layers(),
     layer(id or exact name), editor.
   - **Panel:** a Boxes section in the Generate pane (rows: id, kind, desc, a reference select for From over the shown
     reference layers, delete; Selection -> box, Clear, Copy rows through `boxes_format.js`, the warnings from
     `boxes_model.js`; Copy rows says so when `navigator.clipboard` is missing, as on a plain-http remote ComfyUI).
   - **Geometry:** in `mapExtras(A, kind)` (`:5249` turn, `:5415` followGeometry, `:5600` straighten), when
     `host.boxesInEditor && kind !== "undo"`, map every box's rect and (not for From) src with `mapBox`, writing new
     objects; undo restores from the snapshot (`geometrySnapshot` carries pluginData), never maps back.
2. `getValue()` adds `boxes` and `setValue()` reads it **only when `host.boxesInEditor`** (D6); `serializeForPrompt()`
   adds `selectionBoxId`, `referenceIds` and `boxes` (D7, §4).
3. Host members in **both** hosts and the `EditorHost` typedef: `boxesInEditor` (app `false`, node `true`); the node's
   `boxSwitch(editor)` returns `{ takes: true, count: editor?.pluginData?.boxes?.boxes?.length || 0, schema: "flux3" }`
   and accepts a null editor (the clone's `js/host.js:168`). `npm run types`, `--check`.
4. node_test steps (the stand-ins first record `api.queuePrompt`'s prompt): the Boxes row shows; tool X draws a box with
   synthetic pointer events (the pattern of `tools/brush_test.py:75`) and one undo takes it back; Delete with a box
   selected removes the box and leaves the layer count and pixels as they were; persistence: `v = ed.getValue()`, set
   `ed.pluginData.boxes = { version: 1, boxes: [] }`, `await ed.setValue(v)`, the box is back; `JSON.parse(await
   ed.serializeForPrompt())` carries boxes, referenceIds and selectionBoxId; the remap: after setup, the wrapped
   `api.queuePrompt(0, { output: { "7": { class_type: "InpaintCanvas", inputs: {} }, "9": { class_type: "X", inputs:
   { p: ["7", 14], e: ["7", 15] } } } })` records 21 and 22.
5. The B4 gate runs (§5): the app shows no second X tool or panel, documents save and open as before. Commit Scumble,
   build the clone, commit the clone.

### B5: node-owned pieces and the docs (normal / light)
1. The clone's `js/inpaint_node.js`: the tail remap subgraph-safe: `let g = app.graph, n = null; for (const part of
   String(v[0]).split(":")) { n = g && (g.getNodeById(+part) || g.getNodeById(part)); g = n && n.subgraph; }`, then
   use `n`; a node_test case with a stub parent `{ id: 92, subgraph: { getNodeById } }` and the id "92:7" (unverified
   live: the morning list). `onExecuted` shows `inpaint_boxes` notes as a warn status line.
2. The clone's bridge and MCP: `boxes_list / boxes_add / boxes_set / boxes_remove / boxes_from_selection / boxes_clear`
   in `js/inpaint_bridge.js` `COMMANDS` (through `inpaint_boxes.js`), `gen.boxes` in `set_generation`, the boxes in
   `status`; the tools in `mcp/inpaint_canvas_mcp.py` (+ its README's count; checked with §1's ast line, never
   started). node_test for the bridge commands.
3. Docs in the clone: README (a Boxes section; the outputs table `README.md:673-689` with `box_prompt` and `elements`;
   the stale "not in the Manager's list yet" line `README.md:67-69`), GUIDE.md, a DEVELOPMENT.md section (the
   canvas_state keys, the writer, the outputs). The node's `CLAUDE.md` is gitignored and not in the clone: do not create
   it there and never touch the live one; write the proposed sections (layout: boxes_rows.py, the two outputs, the
   shared box modules; where things stand) into `F:/canvas/dist/node_boxes_CLAUDE_update.md` for the user.
   `examples/inpaint_canvas_flux3_boxes.json`: the canvas outputs in **visible** order (13 fixed, the free `setting_1`
   at 13, `box_prompt` at 14, `elements` at 15) with the links on those slots; *Flux 3 Image*'s input named
   `images.image_1` (copy the dotted Autogrow form from
   `tools/refs/comfy_cloud/edit/image_qwen_image_2_1_image_edit.json:105-118`); `aspect_ratio` "auto"; a note not to
   wire `elements` into `bounding_boxes` at the same time on an edit; marked "not yet loaded in a real ComfyUI".
   Scumble: `docs/PLAN_BOXES.md` a pointer here; `docs/BUILD_NODE.md`; no CHANGELOG line unless the app's behaviour
   changed.
4. Commit both.

### B6: review, fixes, hand-over
1. Read get_usage, then a review workflow (about 8 agents): finders by area (the Python writer against the vectors and
   the app; nodes.py's frame, naming and fit; the editor module and the app's unchanged behaviour; the node-owned js and
   the bridge; the docs against the code), each finder's list checked by a skeptic. **Every agent prompt starts with
   these rules, verbatim:** read only; no git and no command of any kind in F:\Comfyui or in F:\canvas\dist\node_wt
   (reading files there is fine); the node under review is F:/canvas/dist/node_boxes (`git -C
   F:/canvas/dist/node_boxes diff master..boxes` is allowed); no build_node.py, no node_test, no run_gates.sh, no
   electron, no call to ports 8188 or 9555, no mcp__inpaint-canvas__ / mcp__scumble__ / mcp__Scumble__ tools; no file
   writes. Only the main loop runs tests and fixes. Fix the confirmed findings.
2. The full set once more: `node tools/boxes_test.js`, the vectors `cmp`, the clone's unittest, `--check`, node_test,
   the B6 gate runs (§5).
3. Commits; CLAUDE.md's "Where things stand" and §9 here; nothing pushed, nothing in the live node folder.

## 7. Traps (each cost someone before)

- Outputs only ever appended (after `setting_8`); an older node loading a newer workflow drops the tail outputs.
- `box_prompt` and `elements` into the same *Flux 3 Image* on an edit give two JSON arrays (core appends its own).
- Core renames ids to `box_N`: the `elements` path has no caption naming `<id>`s.
- Batch shifts: the Original (selection AND fill != none AND withOriginal AND not refine) and skipped references;
  name from the loop that builds the batch. `crop_image` must go whole into `images.image_1`; more than 10 pictures:
  core raises, the user's *Flux 3 Image (API)* drops silently.
- With fill on, `ref_image_0` is the filled crop: a Keep / Move / Remove source inside the selection is gone there.
- A From box's src is in fractions of its layer **as shown** (the transform tool scales `l.w`, `l.h`, not the pixels;
  an untouched layer goes as its native upload): never measure display pixels against file pixels.
- Python vs JS: `round()` is half to even (use `floor(x + 0.5)`), `json.dumps` spaces and `\u` escapes, `slice(0, 400)`
  counts UTF-16 units, `\b` / `\s` need `re.ASCII`, capitals with `s[0].upper() + s[1:]`, never `str.capitalize()`.
- `cropRect()` is not the node's crop (no `_fit_span_to_multiple` at target_size 0); only nodes.py measures.
- `getValue()` must never return `{}` while a restore loads (the node's invariant 6); state goes into canvas_state,
  never into a widget (invariant 5).
- `build_node.py --check` counts the text `host.` anywhere in a built module, comments included; it checks named
  imports at line start only. A node-owned module's use of editor internals is unchecked: node_test must exercise it.
  No `import * as` of an app-only file.
- The plugin and the core module must never both own X, the panel or the geometry map in one host (the flag decides;
  the app's plugin keeps its own `geometry` handler).
- Keys of an active core tool must be answered before the editor's switch (D = deselect, Delete = clear / delete
  layer).
- A desc names pictures as typed ("image 2", 1-based); rows use `ref_image_k` (0-based). The node's "ref 1" is
  `ref_image_{1 + o}`.
- The live folder: no write, no git, no unittest, no `comfy_cli zip_files`, no bare `build_node.py` /
  `npm run build-node`; always `--node F:/canvas/dist/node_boxes`.

## 8. The morning (for the user; nothing of this runs at night)

1. Look at the clone's branch (`git -C F:/canvas/dist/node_boxes log master..boxes`) and Scumble's local commits
   (`git log origin/main..main`).
2. Know first: until `boxes` is in the live node, Scumble main's `node` / `nodecopy` gates and `build_node.py --check`
   against the live folder are red, and no node build from main may go into the live folder (it would give the node
   outputs and host members its files lack).
3. To try it, with `/queue` empty: `git -C <live node folder> fetch F:/canvas/dist/node_boxes boxes:boxes`, then
   `git -C <live node folder> checkout boxes` (or Claude does it on the user's word); `curl /system_stats`; **restart
   ComfyUI** (new outputs); then `build_node.py --check` against the live folder and node_test.
4. One paid live run with *Flux 3 Image* and `examples/inpaint_canvas_flux3_boxes.json`: do edit rows pass the Comfy
   proxy, does `aspect_ratio` "auto" keep the crop's aspect (D11), does the tail remap work for a canvas in a subgraph?
5. Copy `F:/canvas/dist/node_boxes_CLAUDE_update.md` into the node's (untracked) CLAUDE.md if wanted.
6. The version (0.3.5 or 0.4.0): merge `boxes` into the node's `master` (fast-forward), push Scumble main first (the
   node's DEVELOPMENT.md build mark names a Scumble commit), then the node's bump commit and push (it publishes), and
   watch the registry until the version is Active, not Flagged.
7. After the merge, delete `F:/canvas/dist/node_boxes`.

## 9. As built

(One paragraph per step, written when the step is committed.)

**B0 (2026-10-14 evening).** The clone `F:/canvas/dist/node_boxes` from the live folder (master `beef9dd`), push URL
`no-push-tonight`, branch `boxes`. Baseline: the build into the clone (build `ed14c1f345a46825`, the same as the live
node's; only DEVELOPMENT.md's mark moved), `--check` ok (55 modules, 63 host members), node_test PASS, unittest 32 OK.
The clone's working files show as modified in `git status` (the global `core.autocrlf true` checked them out CRLF, the
build writes LF; `git diff` is empty but for the mark): noise, not a change. `tools/boxes_vectors.js` writes
`tools/boxes_vectors.json` (round 14, grid 31, where 74, way 383, check 25, rows 27, caption 113, apply 14,
elements 5; one vector per line); `--check` compares; `tools/boxes_test.js` §12 checks the file equals a fresh run
(145 of 145). The rows' `names` map a box's `ref` to main's `pictureName`, so the Python writer takes names, not a
layout. Not in the vectors on purpose: an astral character cut in half at 400 UTF-16 units (JS keeps a lone surrogate,
the node drops the half: a Python-only case in B1), `{@ref:i}` markers (the node's descs carry none), `idWords` (the
editor sends `selectionBoxId`). The rounding: `Math.round` emulated exactly (`r = floor(x); r + 1 if x - r >= 0.5`),
not `floor(x + 0.5)` (which gives 1 for 0.49999999999999994; a vector holds it).

**B1 (clone `47d4a5b`).** `boxes_rows.py` (pure Python): `js_round`, `len16` / `cut16` (UTF-16 units; a character
the cut would split is left out whole), `one_line` / `fold` (the ECMAScript whitespace set by code point, lone
surrogates dropped), `dumps` (compact, `ensure_ascii=False`), `check_boxes` (the app's texts, `BoxError`), `grid`,
`rows_flux3(boxes, frame, names, text)` (`names` maps a From box's `ref` to its picture name, int or str keys),
`rows_text`, `clause_of`, `where_words`, `way_words`, `caption_flux3`, `apply_boxes` (`{prompt, rows, notes}`),
`elements_core`. Regexes with `\Z` for JS `$`, `re.I | re.A` for the verbs. nodes.py: `from . import boxes_rows`, else
loaded by file as `inpaint_canvas_boxes_rows` and registered in `sys.modules` (one module object for nodes.py and the
tests; the package path checked by importing the clone as a package over the test stubs). `tests/test_boxes.py`: all
vectors (to the character, lists compared as JSON so 250 and 250.0 differ) and nine Python-only cases; unittest 50 OK.

**B2 (Scumble `8441000`, clone `95c1003`).** The measuring is a pure function too: `boxes_rows.node_outputs(state,
prompt, frame, crop_size, original, loaded, fit, selection, fill)` -> `(box_prompt, elements, notes)`, with
`to_frame` (the app's toFrame), `fit_point` / `fit_src` (§4's pad / crop / stretch, Python's `round` as `_fit_image`
and `common_upscale` use it), `check_payload_box` (pluginBoxes' texts in image pixels; a From box's src in fractions
of its layer), `_free_id` (a duplicate id gets the next number, as pluginBoxes), the notes (left out, a fill under a
Keep / Move / Remove source, a reference not loaded, the crop fit cutting a source off, the bare New box, small boxes
under 48 px at the crop size, the 15000 characters, more than 10 pictures). `run()` keeps `loaded` (index, width,
height as loaded) in the reference loop, calls it inside a second guard, appends `(box_prompt, elements)` after the
settings and returns `ui: {"inpaint_boxes": notes}` **only when there are notes** (so a run without boxes sends no
`executed` event it did not send before; ComfyUI merges a `ui` beside `expand`, `execution.py:360-423`). The plain
`prompt` output is unchanged. `TAIL_OUTPUTS` in the editor: `box_prompt` STRING, `elements` ARRAY. Tests: 18 run()
cases and 2 fit cases (pad and stretch measured on `_fit_image`'s pixels; crop by the formula, the stub ignores it);
unittest 68 OK; the build into the clone (`b402b1b91a4fa333`), `--check` ok, node_test PASS (it does not look at the
outputs yet: B4's remap step).

**B3.** `git mv` of `plugins/boxes/format.js` -> `renderer/editor/boxes_format.js` and `tool.js` ->
`renderer/editor/boxes_tool.js` (`makeTool(env, api)`, `env.docById(id)` its only outside use); the new
`renderer/editor/boxes_model.js` holds the plugin's pure model: `HELP`, `KIND_LABELS`, `TOKEN`, `DEFAULT_ID`, `rectOf`,
`nextId`, `wordsOf`, `aside(size, r)`, `normaliseBox(input, { base, boxes, idBase, size, referenceId(key),
promptNames(id) })`, `addBox` / `setBox` / `removeBox` over a list (`{ boxes, box }`), `tokenOf`, `selectionInput`,
`placed`, `changes`, `cropCheck(boxes, crop, sel)`, `bareOf`, `unplacedOf`, `warningLines`, `mapBox(r, m)`, `mapBoxes`,
`runDesc(b, labels)`, `clipDesc(b)`, `FIELDS`. `plugins/boxes/main.js` imports the three from `/editor/` and keeps the
app's pieces (the plugin data, the Boxes switch, the recipe, the panel, the commands, the generate hook, the geometry
event through `mapBoxes`). No `host.` text and no page-level side effects in the four shared files. `FILES` +=
`boxes.js`, `boxes_format.js`, `boxes_tool.js`, `boxes_model.js`; BUILD_NODE.md a row. `tools/boxes_test.js` §10 imports
the moved formatter, §13 new (11 checks of the model): 155 of 155. Gates: `nb3` (tiles: boxes, commands, lint, types,
all rc 0; lint 21 warnings, none in these files) and `nb3c` (canvas: boxes) ALL PASS.

**B4.** `renderer/editor/inpaint_boxes.js` (in `FILES`): `EditorBoxes(ed)` with a doc adapter for the shared tool
(`makeTool({ docById }, api)`), the data in `ed.pluginData.boxes` (one `pushUndo({ kind: "data" })` per change, then
`notifyChanged`), the first box turning `gen.boxes` on, `fromSelection`, `copyRows` (a warn line when the page has no
clipboard), `cropFrame()` (the editor's `cropRect()`, the span fitted to `multiple_of` at target_size 0 as nodes.py
does, the emitted size; for the overlay and the warnings only), `pointer` / `key` / `deselect` / `selected` / `draw` /
`mapGeometry`, the Boxes section in the Generate pane (`ed.addSection(.., "gen")`: help, note, the shared warning
lines, rows with id, kind, description, Text's words, From's reference select, delete; Selection to box, Clear, Copy
rows; CSS `.ipc-bx-*` in the editor's STYLE). The modal builds it before `host.editorBuilt` when `host.boxesInEditor`
(the modal is built in the constructor, so `ed.boxes` exists while the editor is closed); `addTool("boxes")` beside
the lights tool, `ICONS.boxes`. Hooks in `inpaint_canvas.js`, each `if (this.boxes)`: pointer down / move / up
(`pointer.kind "boxes"`), the window's Escape and `onKey`'s Escape before `pluginKey`, single keys before `pluginKey`
(X picks the tool; D, Delete, the arrows and Escape go to the tool while it is active), `setTool` (deselect / the
hint), the overlay in both tilt branches, `mapExtras` (not for "undo"), `notifyChanged` -> `refresh()`, `setValue`'s
end -> `refresh(true)`. `getValue()` adds `boxes` and `setValue()` reads it only when `host.boxesInEditor`.
`serializeForPrompt()` adds `selectionBoxId`, `referenceIds` and (when the document holds boxes) `boxes` through the
shared `promptPayload` / `selectionBoxIdOf` (boxes_model.js), **only when the switch is on and `host.boxSwitch(this)
.takes`**: a deviation from D7 ("both hosts"), so the app's local recipes (which take no boxes) see no change and no
warn line; its notes (a From box whose layer is not sent) go on the "Queued crop" line as warn. **A deviation from
D8:** the editor sends `boxes: []` when the document holds boxes it had to leave out, and nodes.py makes the
selection's box only when `boxes` is absent (clone `boxes_rows.py`, its test changed). Host members: `boxesInEditor`
(app false, node true; the typedef), the node's `boxSwitch(editor)` `{ takes: true, count, schema: "flux3" }`.
node_test: the api stand-in records the prompts; 11 Boxes steps (the row and the tool, a drawn box and the switch, undo
/ redo, Delete keeps pixels / selection / layers, D duplicates, getValue / setValue, a resize and its undo,
serializeForPrompt with and without the switch, the tail outputs at 13 / 14 / 15, the remap to 21 / 22); PASS.
`tools/boxes_test.js` 157 (promptPayload, selectionBoxIdOf). Gates `nb4` (tiles: boxes, editor, commands, generate,
document, lint, types) and `nb4c` (canvas: boxes): all rc 0 / ALL PASS (lint 21 warnings, none in the box files).
Scumble `ec19c19`, clone `06314fe` (the build, `js/host.js`, the D8 change, DEVELOPMENT.md §25).

**B5.** Clone, node-owned: `js/inpaint_node.js` `graphNodeOf(id)` (each part of "92:7" looked up in the subgraph of
the node before it) for the tail remap; `onExecuted` shows `inpaint_boxes` notes as a warn line "Boxes: .." and logs
them. `js/inpaint_bridge.js`: `boxes_list`, `boxes_add`, `boxes_set` (`new_id` renames), `boxes_remove`,
`boxes_from_selection`, `boxes_clear` through `ed.boxes`, `set_generation(boxes)`, `status.boxes` and
`generation.boxes`. `mcp/inpaint_canvas_mcp.py`: the six tools and `set_generation(boxes)` (52 tools; checked with the
ast line, never started), `mcp/README.md` a Boxes row. Docs: README (the Manager line, the example, a section *Boxes
for FLUX 3*, X in the keyboard table, the outputs table and the tail note), GUIDE.md (a section, X), DEVELOPMENT.md §25
(went with B4's commit). `examples/inpaint_canvas_flux3_boxes.json`: made by a script from the Flux.2 API example
(the canvas outputs in visible order, `box_prompt` at 14 into the prompt, `crop_image` into `images.image_1`, the
canvas `seed` into the seed, `aspect_ratio` auto, resolution 1K, target_size 1024 / multiple_of 16, a Note: not both
outputs on an edit, not yet loaded live); every link checked against its slots by the script.
`F:/canvas/dist/node_boxes_CLAUDE_update.md`: the proposed sections for the node's untracked CLAUDE.md. Scumble:
`docs/PLAN_BOXES.md` a pointer, BUILD_NODE.md a row for `inpaint_boxes.js`, node_test 4 more steps (the subgraph
remap "92:7" -> 21 / 22; the bridge's six box commands, an unknown box's error, `set_generation` boxes and `status`):
PASS. No CHANGELOG line (the app's behaviour did not change).

**B6 (2026-10-15 night).** The review workflow (run `wf_d5d51fce-baa`: 4 finders by area, each list checked by a
skeptic; 15 findings, 11 confirmed, all fixed). Scumble `b717107`: `electron/main/recipes.js` read every canvas
output from slot 13 as a setting, so importing a node workflow that wires `box_prompt` / `elements` (the example)
made a Settings row of the prompt; now `tailOutputs` reads them by name (fromWorkflow by the UI node's output names,
fromGraph passes the page's names to fromPrompt, a plain API prompt by the backend order): a setting at its backend
slot, a consumer of `box_prompt` wired to the plain prompt with a note (a local recipe gets no boxes), one of
`elements` dropped with a note; `tools/recipes_test.js` §12 (199 of 199). `@img` tokens: the shared describe field
invites them and the node sent them raw; now `serializeForPrompt` adds `referenceLabels` and nodes.py writes an
`@imgN` in a description and in the prompt of `box_prompt` as FLUX 3's "image n" of the batch as built (`image 2` =
the first reference without the Original); one that did not load stays, noted (the plain `prompt` output untouched).
The node's switch tooltip and help no longer speak of Generate new / Ideogram 4; the no-clipboard line and the
TAIL_OUTPUTS comment corrected. Clone `6a0ad1e`: `_is_num` answers False for a JSON integer past the float range
(one box left out, not all); the bridge's `boxes_set` takes `text: ""` (a Text box back to New) and `src: []` (a From
box back to its whole layer); D3's wording everywhere ("the plain prompt while the Boxes switch is off"); the
example's guide note is the current GUIDE.md, Flux 3 Image's core version 0.39.0. Not taken: the 15000 note for the
`elements` wiring, a list box's error text, `String()` of odd numbers, the example note's "auto" wording.
The full set: `boxes_test.js` 157 of 157, the vectors `cmp` same, unittest 70 OK, `--check` ok (60 modules, 64 host
members), node_test PASS (47 steps), the MCP file parses (52 tools). Gates `nb6` (tiles: boxes, editor, commands,
generate, document, recipes, comfyview, lint, types): all rc 0 but `comfyview` 24 of 25, its control step "Ctrl+Shift+L
in the editor's window reached no menu" (docs/TESTING.md known flake), the same on a re-run (`nb6r`); `nb6c` (canvas:
boxes) ALL PASS. Nothing pushed, nothing in the live node folder; the morning list is §8.
