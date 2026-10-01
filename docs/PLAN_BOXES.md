# Boxes in the prompt: FLUX 3 Image and Ideogram 4 (research 2026-10-01 night, nothing built)

The user's idea (2026-10-01): a selection sent to FLUX 3 as a bounding box, and, after looking at Kijai's
Ideogram 4 prompt builder, a **plugin** for box prompts made for FLUX 3 and Ideogram 4. This file is the research and a
proposed order; no code was written, no API call was made. The user decides the order and the open questions (§7).

## 1. Sources

- BFL docs, fetched 2026-10-01 as markdown (`https://docs.bfl.ml/<page>.md`, index `https://docs.bfl.ml/llms.txt`):
  `flux_3/flux3_image_bounding_boxes` (the format and the edit rows), `flux_3/flux3_image_layout`,
  `guides/prompting_editing_overview` ("When to use boxes"), `guides/prompting_editing_multi_reference` (a row that
  takes an element from another reference), `guides/prompting_layout` (captions for layouts, not read in full).
- Kijai's node, read only: `custom_nodes/comfyui-kjnodes/nodes/ideogram4_nodes.py` (445 lines) and
  `web/js/ideogram4_prompt_builder.js` (2,701 lines), GPL-3.0 like Scumble. Nothing copied; the format below is
  read from its output code.
- Scumble: `renderer/editor/stitch.js` (`planCrop` / `prepareCrop`), `electron/main/providers/refs.js` (the
  `{@ref:i}` markers and the picture layout), `docs/PLUGINS.md` (extension points), `recipes/ideogram_4.json`.

## 2. FLUX 3 Image: boxes are rows in the prompt

No extra request field: the boxes are a JSON array appended to `prompt` after a space ("Put the caption first, then
a space, then the JSON array"). The strict schema of `/v1/flux-3-image` is therefore untouched; `flux3.js` needs no
change for it.

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

## 4. The catch: the grid is the crop's, and the crop is known only at the run

Scumble does not send the whole image: `planCrop` widens the selection to a crop (padding, the aspect preset, the 16 px
rounding), and FLUX 3 gets the crop as image 1. A box has to be measured in **the crop**, so it can only be written
after `prepareCrop`, inside the run. A plugin that writes the prompt text beforehand does not know the crop (it would
have to repeat `planCrop`, and a different setting would put every box in the wrong place). Two ways:

- **A. A marker, as for references (item 26):** the prompt carries `{@box:<id>}` / the rows as a marker the run
  resolves against the crop (`refs.js` already resolves `{@ref:i}` against the layout). Fits the core, hard for a
  plugin to extend.
- **B. A prompt extension point for plugins (proposed):** `scumble.prompts.register({ id, for: ["flux3",
  "ideogram4"], transform(prompt, ctx) })`, called by `host.runProvider` after the crop and the picture layout are
  known, before IPC `provider:edit`. `ctx`: `{ mode: "edit" | "new", schema, crop: {x, y, w, h} (image px),
  out: {w, h}, pictures: [{ index, name, layerId, box }] , selection: {x, y, w, h} | null, toGrid(rect, frame) }`.
  It returns the prompt; the log and `generate`'s `prompt_sent` show the result as today. A failing transform is
  reported (like a failing filter) and the run goes with the untouched prompt.

B keeps the format knowledge in the plugin (the user's wish), and the same hook later serves other structured
prompts. The hook is small; the plugin is most of the work.

One more seam: the pictures' final order is fixed in the main process by the adapter's `layout(req)`
(`providers/index.js`), after the renderer has sent the request. FLUX 3 puts the crop first today, so `ref_image_0` is
the crop and `@img1` is `ref_image_1`, but a transform must not hard-code that. Either the transform writes the
picture as a marker (`{@refimg:i}`, i = the renderer's picture index) that main resolves next to `{@ref:i}` with the
layout's numbering from 0, or the renderer asks main for the layout first. The marker is the smaller change and
matches item 26.

## 5. Proposed steps

1. **S1, the selection as a box (core, FLUX 3 only, about 1 day).** A Settings row on the FLUX 3 recipe, "Selection
   as box" (default off until the live A/B, §6). On an edit with a selection: the selection's bounds in the crop grid
   become a New row `{"id": "edit_1", "from": null, "src_bbox": null, "tgt_bbox": [...], "desc": <prompt>}`, the
   instruction reads `In <ref_image_0>, <prompt> <edit_1>. Keep the rest of the image unchanged.`; when the prompt
   names a reference (`@img1`), a second row takes it from that picture (`from: "ref_image_k"`, `src_bbox` = the
   reference layer's opaque bounds on its picture, else `[0, 0, 1000, 1000]`, `tgt_bbox` = the selection). A
   selection under about 48 px on a side in output pixels gets a status note (the docs' 40 x 25 limit). Written as a
   transform with the `ctx` of §4 B from the start, so step 2 only moves it behind the plugin hook.
   Tests (light tier): plain-Node tests of the grid conversion and the rows against a scripted crop.
2. **S2, the prompt hook (core, about half a day).** `scumble.prompts` in `renderer/plugins.js`, the call in
   `host.runProvider`, the `{@refimg:i}` marker in `refs.js`, `docs/PLUGINS.md`. S1's transform becomes the first
   registered one.
3. **S3, the box plugin "Boxes" (built-in plugin, 2 to 3 days).** A tool to draw, move and resize labelled boxes on
   the canvas (overlay in image pixels, like the film pack's control points), a panel in the Generate pane with one
   row per box: id, kind (New / Keep / Move / Remove / From reference + which), `desc`, text, up to 5 colours;
   "Selection to box". Formatters: FLUX 3 edit rows, FLUX 3 layout rows for Generate new (`bbox`, grid of the output
   frame), Ideogram 4 caption (high-level description from the prompt, background row, elements). Where the boxes
   live is a decision (§7.3).
4. **S4, Keep rows from the in-app objects (about 1 day, optional).** The docs build anchor rows with "a vision model
   that lists the main elements with their boxes"; Scumble has SAM2's object map (`host.findObjects`): each object's
   bounds in the crop as a Keep row, the description from an upsampling model or left short ("object 3"). Only if S1
   to S3 show that anchors are needed.
5. **S5, Ideogram 4** once §6.4 says which route takes the caption (fal or a local recipe).

## 6. Live checks (with the user present: their key, their credits)

1. FLUX 3, the same edit with and without S1's New row (2k, 10 credits each): does the change stay inside the box,
   does the rest of the crop hold better than today?
2. A reference placed by a From-reference row vs. the plain instruction.
3. A Remove row (an object in the selection removed, the background filled).
4. Ideogram 4 on fal with a JSON caption, prompt expansion None: does it follow the boxes, or does fal / the model
   read the JSON as text to render?
FLUX 3 runs take one to two minutes; four or five runs are about 50 credits.

## 7. Open questions for the user

1. Plugin or core? Proposed: the hook in the core, the box editor and the formatters as a built-in plugin (like the
   film pack), S1 as the first transform.
2. S1's default: off until check 6.1 says it helps, or on for FLUX 3 from the start?
3. Where the boxes live: in the document (the `.scumble` format and autosave: the full test tier) or in the plugin's
   storage per document (lost on a fresh machine). Proposed: in the document, as plain data of the tab state.
4. Ideogram 4: through fal (exists, unverified) or a local ComfyUI recipe with the user's Ideogram 4 nodes?
5. Should the prompt field show the rows (editable text) or only the box panel (the rows added at the run, visible
   in `prompt_sent` and the log)? Proposed: only the panel; raw JSON in the prompt field is easy to break.
