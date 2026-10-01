# Boxes in the prompt: FLUX 3 Image and Ideogram 4 (item 28; researched 2026-10-01 night, planned S1-S4, nothing built)

The user's idea (2026-10-01): a selection sent to FLUX 3 as a bounding box, and, after looking at Kijai's
Ideogram 4 prompt builder, a **plugin** for box prompts made for FLUX 3 and Ideogram 4. §1-§3 are the research, §4
the design decision, §5 the steps, §8-§11 the implementation plan for S1-S4 (the user's ask the same night). No code
was written, no API call was made. The user decides the open questions (§7).

## 1. Sources

- BFL docs, fetched 2026-10-01 as markdown (`https://docs.bfl.ml/<page>.md`, index `https://docs.bfl.ml/llms.txt`):
  `flux_3/flux3_image_bounding_boxes` (the format and the edit rows), `flux_3/flux3_image_layout`,
  `guides/prompting_editing_overview` ("When to use boxes"), `guides/prompting_editing_multi_reference` (a row that
  takes an element from another reference), `guides/prompting_layout` (captions for layouts, not read in full).
- Kijai's node, read only: `custom_nodes/comfyui-kjnodes/nodes/ideogram4_nodes.py` (445 lines) and
  `web/js/ideogram4_prompt_builder.js` (2,701 lines), GPL-3.0 like Scumble. Nothing copied; the format below is
  read from its output code.
- Scumble: `renderer/editor/host.js` (`runProvider` 1350, `generateNew` about 1560, `refPrompt` 1119,
  `layoutShape` 1236), `renderer/editor/stitch.js` (`planCrop` 349, its `info` 435, `prepareCropAsync` 733),
  `electron/main/providers/index.js` (`edit()` about 180: `layoutFor`, `checkPictures`, `resolveNames`, then the
  adapter), `electron/main/providers/refs.js` (`layoutOf`, `resolveMarkers`), `electron/main/providers/flux3.js`
  (`body()` 208, `layout()` 242), `renderer/plugins.js` (API 2, `documents.data`), `plugins/glb/main.js` (per-document
  data in a plugin), `docs/PLUGINS.md`, `recipes/flux3.json`, `recipes/ideogram_4.json`.

## 2. FLUX 3 Image: boxes are rows in the prompt

No extra request field: the boxes are a JSON array appended to `prompt` after a space ("Put the caption first, then
a space, then the JSON array"). The strict schema of `/v1/flux-3-image` is therefore untouched; `flux3.js`'s body
needs no new field.

- **Grid**: every box is `[top, left, bottom, right]`, integers 0 to 1000 from the top-left corner, whatever the
  size; "the 0-1000 grid stretches with the frame. Send the aspect ratio you designed the boxes for". BFL's helper:
  `[round(top/h*1000), round(left/w*1000), round(bottom/h*1000), round(right/w*1000)]`.
- **Ids**: the text names each element as `<id>` (lowercase name and a number, `<knight_1>`); each row carries the
  same `id`. Pictures are `<ref_image_0>` (the first of `images`), `<ref_image_1>` ...
- **New image** (layout): caption + rows `{ "id", "bbox", "desc" }`.
- **Edit**: rows `{ "id", "from", "src_bbox", "tgt_bbox", "desc" }`:

  | Row | `from` | `src_bbox` | `tgt_bbox` | Effect |
  | - | - | - | - | - |
  | Keep | `"ref_image_0"` | its box | the same box | stays where it is |
  | Move | `"ref_image_0"` | its box | a new box | moves or resizes it |
  | New | `null` | `null` | its box | generates `desc` there: adds, replaces, recolours |
  | Remove | `"ref_image_0"` | its box | `null` | removed, filled with what was behind |

  A row with `from: "ref_image_1"` takes an element **from the second picture**: `src_bbox` marks it there,
  `tgt_bbox` where it goes in the output (the docs' lamp onto a sideboard).
- **Tips and limits** (the docs): boxes set placement and scale, "not clipping masks", an element may reach past
  its box; a new element in a box of about 40 x 25 px "often did not appear"; state additions and removals in the
  instruction as well as in the rows (they should agree); a Keep row per element that has to stay ("unlisted areas
  usually hold, but anchors make it explicit"); each line of text in its own row with the words quoted in `desc`;
  "pixels outside the edited boxes usually stay identical". When to use boxes at all: "when several similar objects
  match the description, or when you need to specify a position or size".
- The expanded prompt of our live edit (`info.expanded_prompt`) held such rows: FLUX 3 writes them itself when it
  plans an edit, so sending our own is the documented way to steer that plan.

## 3. Ideogram 4: a JSON caption (Kijai's builder)

Kijai's node writes Ideogram 4's structured caption as the whole prompt:

```json
{
  "high_level_description": "...",
  "style_description": { "aesthetics": "", "lighting": "", "photo": "", "medium": "", "color_palette": ["#RRGGBB"] },
  "compositional_deconstruction": {
    "background": "...",
    "elements": [
      { "type": "obj", "bbox": [ymin, xmin, ymax, xmax], "desc": "...", "color_palette": ["#RRGGBB"] },
      { "type": "text", "bbox": [ymin, xmin, ymax, xmax], "text": "Sauna", "desc": "..." }
    ]
  }
}
```

The same grid as FLUX 3 (0 to 1000, `[ymin, xmin, ymax, xmax]`); the builder also offers `xy` order and absolute
pixels as non-standard options (for Qwen). Its comments: the key order matters, and once a style is chosen "the
verifier requires every style key present (in order)" (blanks rather than omitted; `photo` style: aesthetics,
lighting, photo, medium; `art_style`: aesthetics, lighting, medium, art_style); an element without a place omits
`bbox`; at most 5 colours per element. There is no edit form (no `from` / `src_bbox`): it describes a whole picture.

Scumble's `ideogram_4` recipe runs on fal (`ideogram/v4/image-to-image`, text `ideogram/v4`), never run live. Whether
fal's endpoint reads a JSON caption, or its prompt expansion ("Prompt expansion" row: None / Medium / Large) rewrites
it, is not documented: one live run decides (§6). Ideogram 4 also runs locally in ComfyUI (the user has the
"Ideogram 4 Edit Rebalance" nodes in `ComfyUI-ConditioningKrea2Rebalance`); a local recipe would take the caption as
its prompt text.

## 4. The design: geometry from the renderer, rows written in main

**The catch.** Scumble does not send the whole image: `planCrop` widens the selection to a crop (padding, the aspect
preset, the 16 px rounding), and FLUX 3 gets the crop as `images[0]`. A box has to be measured in **the crop**, so it
can only be computed after `prepareCropAsync`, inside the run; and the pictures' final order and names
(`ref_image_k`) are fixed in the main process by the adapter's `layout(req)` (`providers/index.js` `layoutFor`),
after the renderer has sent the request. A plugin that writes box rows as text into the prompt beforehand knows
neither, so it would put every box in the wrong place and name the wrong picture.

**Decision.** The two halves go where their knowledge is:

- **The renderer sends geometry, not text:** `request.boxes`, every box in **fractions of the frame** (the crop of
  an edit, the document of Generate new), with its kind, id, description and, for a box taken from a reference, the
  reference's index (the same index the `{@ref:i}` markers use). Mapping image pixels into the crop is the renderer's
  (`info.bbox` of `planCrop`), and fractions need no picture size on either side.
- **Main writes the rows** in a new `electron/main/providers/boxes.js`, called by `index.js` `edit()` right after
  `resolveNames` (where the markers become names) and before the adapter's `body()`: it knows the layout (which slot
  is `ref_image_k`), the schema (`options.boxes`: `"flux3"`, later `"ideogram4"`), the grid and the axis order. The
  rows are appended to `req.prompt`, so the log, `generate`'s `prompt_sent` and `editor.lastSentPrompt` show exactly
  what went out, as they do for the names today.
- **Plugins supply boxes, not prompt text:** a new extension point `scumble.generate.register({ id, boxes(doc, ctx)
  })` returns boxes in image pixels; the core maps them and sends them. The selection-as-box of S1 is the first
  source (built in, behind a recipe row), the Boxes plugin of S3 the second. The format knowledge is in one place
  (`boxes.js`, plain-Node testable), the UI in the plugin, as the user asked.
- **Only a recipe that declares `options.boxes` gets boxes.** Any other recipe ignores them with one status note
  ("The boxes were not sent: Seedream 4.5 takes none."), so boxes kept in a document never block a run elsewhere.

## 5. Steps (each one a session; the user's rule)

1. **S1, the selection as a box** (core, FLUX 3 only, about 1 day): §8.
2. **S2, the plugin hook** (core, about half a day): §9.
3. **S3, the built-in plugin "Boxes"** (2 to 3 days, three sessions S3a-S3c): §10.
4. **S4, Keep rows from the in-app objects** (about 1 day, optional): §11.
5. **S5, Ideogram 4** once §6.4 says which route takes the caption (fal or a local recipe): `options.boxes:
   "ideogram4"` on that variant, a second formatter in `boxes.js` (the prompt as `high_level_description`, a box of
   kind `background` as `background`, the others as elements, `text` rows with the words), nothing new in the UI.
   Not planned in detail here.

Live checks 6.1 to 6.3 come **after S1 and before S3**: if the box changes nothing by eye, S3 is not worth three days.

## 6. Live checks (with the user present: their key, their credits)

1. FLUX 3, the same edit with and without S1's New row (2k, 10 credits each): does the change stay inside the box,
   does the rest of the crop hold better than today?
2. A reference placed by a From-reference row vs. the plain instruction.
3. A Remove row (an object in the selection removed, the background filled).
4. Ideogram 4 on fal with a JSON caption, prompt expansion None: does it follow the boxes, or does fal / the model
   read the JSON as text to render?
FLUX 3 runs take one to two minutes; four or five runs are about 50 credits.

## 7. Open questions for the user

1. Plugin or core? Proposed (§4): geometry and the hook in the core, the rows in main's `boxes.js`, the box editor
   as a built-in plugin (like the film pack), S1's selection box as a built-in source behind a recipe row.
2. S1's default: off until check 6.1 says it helps, or on for FLUX 3 from the start? Planned: off.
3. ~~Where the boxes live~~ Answered by the code: `scumble.documents.data(doc)` (plugin API 2) is a JSON object per
   plugin and per document, saved in the session and in the `.scumble` file, riding along when the plugin is off; the
   glb plugin keeps its objects there. No format change, so the full test tier is not triggered; the document gate
   covers the mechanism already.
4. Ideogram 4: through fal (exists, unverified) or a local ComfyUI recipe with the user's Ideogram 4 nodes?
5. Should the prompt field show the rows (editable text) or only the box panel (the rows added at the run, visible
   in `prompt_sent` and the log)? Planned: only the panel; raw JSON in the prompt field is easy to break. The panel
   gets "Copy rows" for pasting into another tool.
6. A box that reaches outside the selection (Move, Remove, a New box drawn by hand): the stitch pastes the answer
   inside the selection (`paste: "selection"`) and would clip the moved element away. Planned: the panel warns and
   offers one click to set Paste to "crop" for this document; not switched silently.

## 8. S1: the selection as a FLUX 3 box (core)

**Files.** `recipes/flux3.json`; `renderer/editor/boxes.js` (new, pure ES module like `comfyrefs.js`: no DOM);
`renderer/editor/host.js` (`runProvider`, `generateNew`); `electron/main/providers/boxes.js` (new);
`electron/main/providers/index.js` (`edit()`); `electron/main/providers/flux3.js` (the header comment only);
`tools/boxes_test.js` (new); `tools/flux3_test.js`; `docs/RECIPES.md` "FLUX 3 Image"; `docs/MANUAL.md`;
`CHANGELOG.md` Unreleased.

**The recipe.** `providers.bfl.options.boxes: "flux3"` and a third Settings row
`{ "index": 3, "key": "selection_box", "label": "Selection as box", "spec": ["BOOLEAN", { "default": false }] }`.
`selection_box` is not an API field: `flux3.js` `body()` only copies keys in `FLUX3_PARAMS` and `accepts`, so the
row never reaches the request body (`flux3_test.js` gets a check for that). The `text` shape gets no row: Generate
new has no selection.

**The box shape (renderer to main).** `request.boxes: Box[]`, optional, empty = absent:

```js
{ id: "edit_1",                      // /^[a-z][a-z0-9]*_[1-9][0-9]*$/, unique per request
  kind: "new" | "keep" | "move" | "remove" | "from",
  rect: [l, t, r, b],                // fractions 0..1 of the frame (the crop / the new image): the target
  src: [l, t, r, b] | null,          // keep / move / remove: where it is in the frame; from: where it is in the reference
  ref: null | i,                     // from: the reference's index as the {@ref:i} markers count (0-based, the Original included)
  desc: "..." }                      // at most 400 characters, newlines folded
```

Fractions rather than pixels: the renderer knows the crop, main knows the layout, neither needs the other's sizes.

**Renderer, `renderer/editor/boxes.js`.** Pure functions with plain-Node tests:
- `frameOf(info)`: `{ x: info.bbox[0], y: info.bbox[1], w: info.bbox[2], h: info.bbox[3] }` (image pixels).
- `toFrame(rectPx, frame)`: `[l, t, r, b]` image pixels into fractions, clamped to 0..1; returns `null` when the
  clamped box is empty (the box lies outside the frame) or thinner than 1/1000 on a side.
- `selectionBox(bounds, frame, { prompt, pair })`: the selection's bounds (`editor.selectionBounds()`, `[x0, y0, x1,
  y1]` image px, `null` without a selection) as
  one box: `{ id: "edit_1", kind: "new", rect, src: null, ref: null, desc: prompt }`; with a `pair` (the first
  `named.pairs` entry, an `@img` token the prompt carries, `pair.ref` its picture index) the kind is `"from"`,
  `ref: pair.ref`, `src: [0, 0, 1, 1]` (the reference picture is the layer's own pixels, so the whole picture is the
  element). The `desc` is the prompt with the `{@ref:i}` markers still in it: main resolves them in the rows too
  (§8 main, below), so a reference named in the desc gets its name.
- `smallBox(rect, emitted)`: true when `rect` is under 48 px on a side at the emitted size (the docs' 40 x 25 limit
  with a margin): the run goes, with a note.

**Renderer, `host.runProvider`.** After `prep` and `named`, before `request`:
```js
const takesBoxes = shape.options && typeof shape.options.boxes === "string";
let boxes = [];
if (takesBoxes && info.has_selection && truthy(params.selection_box)) {
    const b = selectionBox(editor.selectionBounds(), frameOf(info), { prompt: named.prompt, pair: named.pairs[0] || null });
    if (b) boxes.push(b); if (b && smallBox(b.rect, info.emitted)) editor.lastRunNotes.push("The selection is small for a box ...");
}
request.boxes = boxes;
```
`truthy` reads the BOOLEAN row like `groundingOf` does (true / "true" / 1). `generateNew` sends `boxes: []` in S1
(the plugin fills it in S2). The status line after the run adds "Sent with 1 box." when boxes went, and the notes
main returns (`res.notes`) land in `lastRunNotes` as today.

**Main, `electron/main/providers/boxes.js`.** Required by `index.js`; plain Node, no Electron:
- `schemaOf(req)`: `req.options && req.options.boxes` when it is `"flux3"` (later `"ideogram4"`), else `null`.
- `checkBoxes(boxes)`: shape, ids unique and well formed, fractions in 0..1 with `l < r`, `t < b`, kinds known,
  `ref` an integer for `from` only, `desc` a string; throws with the box's id ("Box edit_1: ...: nothing was sent").
- `grid(rect)`: `[round(t*1000), round(l*1000), round(b*1000), round(r*1000)]`, clamped, at least 1 apart.
- `pictureName(lay, ref)`: the slot of the picture with that `ref` in `lay.pictures` (`field` `images[k]`) as
  `ref_image_k`; the frame itself (`role: "crop"`) is `ref_image_0` on an edit; a `from` box whose picture is not
  sent (`checkPictures` stripped it, or `ref` is past the list) refuses like an unresolvable marker does.
- `rowsFlux3(req, lay)`: one row per box: new `{ id, from: null, src_bbox: null, tgt_bbox }`, keep `{ id, from:
  "ref_image_0", src_bbox, tgt_bbox: src_bbox }`, move `{ from: "ref_image_0", src_bbox, tgt_bbox }`, remove `{
  from: "ref_image_0", src_bbox, tgt_bbox: null }`, from `{ from: "ref_image_k", src_bbox, tgt_bbox }`; `desc` with
  the markers resolved through `resolveMarkers(desc, lay.pictures, pattern)` (so "image 2" appears in a desc as in
  the prompt) and folded to one line. On a text run (`req.kind === "text"`) every box is a layout row `{ id, bbox,
  desc }` and the kinds other than `new` refuse ("a new image has no source to keep or move").
- `instructionFlux3(prompt, boxes, lay)`: the prompt, then for every box whose `<id>` the prompt does not mention, one
  sentence (the docs: the instruction and the table should agree): new "Add <edit_1> in its box.", from "Place
  <edit_1> from <ref_image_2> in its box.", move "Move <sofa_1> to its new box.", remove "Remove <cat_1>.", keep
  "Keep <log_1> unchanged."; on an edit, when no box mentions the frame, "In <ref_image_0>, " opens the first
  sentence. S1's single box gets "Add <edit_1> in its box." or "Place <edit_1> from <ref_image_1> in its box.".
- `applyBoxes(req, lay)`: `{ prompt: instruction + " " + JSON.stringify(rows), notes }`; `index.js` calls it after
  `resolveNames` when `req.boxes.length`: no schema, the boxes are dropped with the note "The boxes were not sent:
  <label> <model> takes none."; a schema, the prompt is replaced. The log's success record gets `boxes: n`.

**Tests (light tier: a provider feature built against docs).** `tools/boxes_test.js`: the grid conversion (BFL's own
example `to_bbox(384, 108, 1536, 972, 1920, 1080) = [100, 200, 900, 800]`), every kind's row, `from` against a
layout with the Original (the index shifts by one as the markers do), the refusals, the instruction sentences, the
text run's layout rows; the renderer's `boxes.js` imported as an ES module (as `tools/comfyrefs_test.js` does) for
`toFrame` and `selectionBox` with a crop that cuts the selection. `tools/flux3_test.js`: a request with one box ends
in the JSON array and carries no `selection_box` field; a request without boxes is byte-identical to today.
`tools/recipes_test.js` picks up the new row by itself. One look in the app with the loopback provider is not
possible (it declares no `options.boxes`); the user's live check 6.1 is the look.

**Docs.** `RECIPES.md` "FLUX 3 Image": the row, the shape, what is sent; `MANUAL.md` one paragraph under FLUX 3;
`flux3.js` header line 13 ("Bounding boxes go into the prompt itself (not built here)") rewritten.

## 9. S2: the plugin hook `scumble.generate` (core)

**Files.** `renderer/plugins.js`; `renderer/editor/host.js` (`runProvider`, `generateNew`); `plugins/sample/main.js`;
`docs/PLUGINS.md`; `tools/commands_test.py` (one step); `tools/boxes_test.js` (the mapping of plugin boxes).

**The extension point.**
```js
scumble.generate.register({
    id: "boxes",
    boxes(doc, ctx) -> Box[] | Promise<Box[]>,   // image pixels; [] or null for none
});
```
`ctx = { mode: "edit" | "new", recipe: id, provider, model, schema: ctx.schema ("flux3" | null), frame: { x, y, w,
h } (image pixels: the crop, or the document for a new image), selection: { x, y, w, h } | null, references: [{
index, layerId }] (the pictures of this run as the markers count them) }`. A plugin box is the §8 shape with `rect`
and `src` in **image pixels** and `from` as a **layer id** (`layer: "L12"`) instead of `ref`; the core maps `rect`
and `src` with `toFrame`, drops a box outside the frame with a note naming its id, resolves `layer` to the index
through `ctx.references` (a layer that is not sent refuses with the layer's name), and suffixes a duplicate id
(`_1` → `_2`) across sources. `plugins.js` keeps `regs.generate`; `export async function collectBoxes(ed, ctx)` runs
every registered source in plugin order, a throwing source is reported like a failing filter (`report(entry, ...)`,
status line) and skipped, the run goes on. `API_VERSION` 3. `unload` / `reload` clear the registrations like the
others (`removeRegs`).

**host.js.** `runProvider`: when `takesBoxes`, `ctx.frame = frameOf(info)`, the S1 selection box first, then
`collectBoxes`; `generateNew`: `ctx.mode = "new"`, `frame = { 0, 0, width, height }` (the requested size; the
document's canvas is the design frame the user drew on, and `generateNew` takes `width`/`height` from the document
unless the dialog says otherwise), `references` from `refIds`. Both only when the variant declares `options.boxes`
(for a text run the `text` shape's options, else the variant's). An agent's `generate` and `generate_new` return
`boxes: n` next to `prompt_sent`.

**Sample plugin.** `plugins/sample/main.js` registers a `generate` source that answers one fixed box when a
`storage` flag is on (off by default), so `tools/commands_test.py` can switch it on, run the loopback recipe once
with a scripted `options.boxes`... the loopback provider declares none: the test instead calls the renderer's
`collectBoxes` directly through the console (`import("./plugins.js")`) with a fake `ctx` and checks the mapped
result; one step.

**Docs.** `PLUGINS.md`: a "Generate" section (the shape, image pixels, which recipes take boxes, the note on a
dropped box), the table of the `scumble` object, API 3 in the version line.

## 10. S3: the built-in plugin "Boxes" (three sessions)

**Folder.** `plugins/boxes/` with `plugin.json` (`"registers": ["tool", "panel", "action", "command", "generate"]`,
`enabledByDefault: true`), `main.js` (registration, the data), `panel.js` (the rows), `tool.js` (the canvas tool and
the overlay), `format.js` (the FLUX 3 rows for "Copy rows", the same code main runs is **not** shared across the
process boundary: the plugin keeps a small copy for the clipboard text only, tested against the same vectors).

**Data.** `scumble.documents.data(doc)`: `{ version: 1, boxes: [{ id, kind, rect: [l, t, r, b] (image px), src,
layer, desc, text, colour }], pasteWarned }`. The `geometry` event maps `rect` and `src` by `m` (the matrix of
`docs/PLUGINS.md`), new objects as the docs demand. A `text` row writes `desc` as `text reading "..."` plus the desc
(the docs: each line of text in its own row).

**S3a, data, panel, commands (1 day).** The panel in the Generate pane (`pane: "gen"`, title "Boxes"): one row per
box with the id (validated against the pattern, a duplicate refused), the kind (New / Keep / Move / Remove / From
reference), the desc (a one-line field that grows), for From the reference layer (a select of the shown reference
layers by name), for a text box the words; buttons "Selection → box" (the selection's bounds as a New box with the
prompt as its desc, like S1, so the user can keep it and edit it), "Clear", "Copy rows" (the FLUX 3 rows of the
current boxes against the **document** frame, with a tooltip that the run measures them in the crop). The
`generate` source answers the boxes of the document when the recipe takes boxes; otherwise the panel shows "The
recipe FLUX 3 Image sends boxes; Seedream 4.5 does not." under its title. Commands (the command core, so the
assistant and MCP agents place boxes): `boxes_list`, `boxes_add({ id, kind, rect, src, layer, desc, text })`,
`boxes_set(id, patch)`, `boxes_remove(id)`, `boxes_from_selection({ id, desc })`, `boxes_clear`. Each change is one
undo step through `documents.data` (as the glb plugin does it) and marks the document changed.

**S3b, the tool and the overlay (1 day).** `scumble.tools.register({ id: "box", label: "Boxes", key: "X", ... })` (B
is the editor's own; of the free letters X reads as "boxes"; the film pack holds K, the AI label plugin U): drag on
empty canvas draws a New
box (the panel row appears, the id `box_n` with the next free number), click selects (the panel row highlights),
drag moves, eight handles resize (hit radius 6 / `scale` px), Delete removes the selected box, Escape deselects,
Ctrl+D duplicates, arrows nudge by 1 px (Shift 10), Alt-click cycles overlapping boxes (Kijai's builder has the
same gestures; they are the common ones). The overlay (`draw(doc, ctx, { scale, dpr })`, `drawAlways: true` while
the panel is open) paints each box in its kind's colour (New green, Keep grey, Move blue with a dashed source box
and an arrow, Remove red hatched, From violet with the reference's name), the id tag at the top-left, the desc's
first words inside when the box is wide enough; line widths and fonts divided by `scale * dpr`. The Move kind: the
box drawn is the target; "Set source" in the row lets the next drag set `src`. The From kind: the source rectangle
is on the reference layer, drawn on its layer bounds when that layer is visible.

**S3c, the frame and the paste (half a day).** The panel shows the **crop frame** the run would use: it asks
`planCrop(cropSettingsOf(editor, host.nodeParams, host.cropLimits()), sel)` through `scumble.host` (unstable API, the
plugin is built in) and draws the frame as a thin outline while the tool is active, so the user sees which boxes
the crop cuts. A box outside the selection with a kind that changes pixels there (Move's target, Remove, a New box
drawn outside): a warning row "Box sofa_1 lies outside the selection: the result is pasted inside the selection and
would cut it. Set Paste to crop" with a button that does it (`editor.cropSettings.paste = "crop"`, through the
editor's own setter so the panel updates). Generate new: the frame is the document; the same overlay.

**Tests (normal tier).** `tools/boxes_test.py`, gate `boxes` on the tiles backend: the commands (add, set, remove,
list, from_selection), the undo step, the tool through the pointer hooks (draw, move, resize, delete, as
`film_test.py` drives the control points), the overlay drawn (a pixel of the box's colour on the screen canvas),
save and open of a `.scumble` with boxes (the data rides in `documents.data`), the `geometry` remap on a crop, and a
run against a scripted `window.scumble` provider call (a `provider:edit` stub through CDP) that checks the request's
`boxes` fractions against the crop's `info.bbox`. `tools/boxes_test.js` gets `format.js`'s vectors.

**Docs.** `docs/MANUAL.md` a section "Boxes" (what a box does per model, the kinds, the paste note), `docs/PLUGINS.md`
"Built-in plugins", `docs/COMMANDS.md` the six commands, `README.md` one line, `CHANGELOG.md`.

## 11. S4: Keep rows from the in-app objects (optional)

The docs build anchor rows with "a vision model that lists the main elements with their boxes". Scumble has the
object map of the hover tool: `editor.objects = { ids: Uint16Array(w * h), count, w, h, hash, layerId }`, filled by
SAM2 in-app (`host.findObjects` via `editor.ensureObjects()`) or by the ComfyUI helper.

**Plugin API.** `Document.objects({ ensure = true })` → `Promise<{ count, bounds: [{ id, x, y, w, h, area }] }>`:
one pass over `ids` collecting min / max per id into four `Int32Array(count + 1)` (ids are 1-based, 0 is none), `area`
the pixel count; with `ensure` it runs `ensureObjects()` first when the map is missing or stale (the hash of the
current picture) and answers `null` when no model is downloaded (the status line says so, as the hover tool does).
`docs/PLUGINS.md` `Document` table.

**Plugin.** An action and a panel button "Objects → Keep boxes" (`boxes_from_objects({ max = 12, minArea = 0.02 })`
as a command): objects whose bounds intersect the selection's crop frame (the panel's `planCrop` of S3c), ordered by
area, the ones overlapping the selection by more than half **left out** (they are what changes), at most `max`,
smaller than `minArea` of the frame skipped (the docs' tiny-box limit and the token budget), each a Keep box
`object_k` with `desc: "object k"`. The descriptions are weak without a vision model; the model sees the picture,
and the docs say unlisted areas usually hold anyway, so the Keep rows are explicit anchors first. A later button
"Describe objects" could ask the prompt-upsampling LLM for eight words per object when its backend takes pictures
(`tools/llm_images_test.js` shows which do); not in S4.

**Tests.** `tools/boxes_test.js`: the bounds pass on a synthetic id map (three objects, one touching the edge). The
app path (`objects()` through a real SAM2 model) by eye on the user's machine, where the model is downloaded; the
`ailabel` gate does not cover SAM2 either.

## 12. Order and sessions

| Session | Step | Commit |
| - | - | - |
| 1 | S1 (`boxes.js` both sides, the row, `boxes_test.js`, docs) | "FLUX 3: the selection as a box (item 28 S1)" |
| - | live checks 6.1-6.3 with the user; decide on S3 | - |
| 2 | S2 (`scumble.generate`, sample plugin, PLUGINS.md) | "Plugins: generate sources supply boxes (S2)" |
| 3 | S3a (data, panel, commands) | "Boxes plugin: panel and commands (S3a)" |
| 4 | S3b (tool and overlay) | "Boxes plugin: the tool (S3b)" |
| 5 | S3c (crop frame, paste warning), `boxes_test.py`, manual | "Boxes plugin: the frame and the paste (S3c)" |
| 6 | S4 (`Document.objects`, Keep boxes) | "Boxes plugin: Keep rows from the objects (S4)" |

A release after session 5 at the earliest (S1 alone is a row most users would not find); the CHANGELOG section
grows per step under Unreleased.
