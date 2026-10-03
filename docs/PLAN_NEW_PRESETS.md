# Generate new with presets: a canvas made for the model and its boxes (item 34; the user, 2026-10-03)

**Status (2026-10-03):** an item of the list, written down from one reading of the code; not split into sessions,
nothing built. The user decides the open questions (§5) before a session plans it.

The user's ask (2026-10-03, after 0.1.39): "wie können wir flux3 bbox prompting als 'generate new' nutzen? macht es
sinn presets für 'new' zu nehmen, also auswahl aspect ratio und model auswahl (die modelle haben ja unterschiedliche
standard bildgrössen) und auswahl 1k, 2k, 4k". The answer was yes, with the reasons below; then "schreibe in plan der
zukünftigen features".

## 1. What exists (read 2026-10-03)

- **Boxes with Generate new work since item 28 S2 / S3d** (`docs/PLAN_BOXES.md`): a canvas, boxes drawn with the Boxes
  tool (X), the *Boxes* switch under the prompt on, Generate new on FLUX 3 Image. A text run sends each box as a layout
  row `{ id, bbox, desc }` (`electron/main/providers/boxes.js` `rowsFlux3`).
- **On a new image FLUX 3 takes New boxes only.** Every other kind stops the run with "Box <id> is a <kind> box, and a
  new image has no source to keep or move: nothing was sent." That message fits Keep, Move and Remove; for Text and
  From reference it is wrong (a Text box has no source, and a From box's reference *is* sent with Generate new).
  Ideogram 4 on a new image places New and Text boxes (`placesIdeogram4`).
- **Never run live:** FLUX 3 Generate new with boxes. The live checks of `docs/PLAN_BOXES.md` §6.1-6.3 were edits;
  §6.4 (Ideogram 4, 2026-10-03) ran a new image with boxes.
- **The frame of Generate new is the document** (`renderer/editor/host.js`, the plugins' boxes in the text run): the
  boxes are fractions of the picture they were drawn on, and the new image is made at the dialog's size, "stretched
  when the aspect differs". BFL's docs on the grid: "the 0-1000 grid stretches with the frame. Send the aspect ratio
  you designed the boxes for."
- **The Generate new dialog** (`renderer/shell.js` `openGenerateNew`, `genSize`, `genFillSizes`):
  - aspects: the fixed `GEN_ASPECTS` (free, 1:1, 3:2, 2:3, 4:3, 3:4, 16:9, 9:16, 21:9); "1:1" at the first opening,
    then whatever was chosen last, never the document's aspect; *free* starts its width and height from the document;
  - the size: the variant's `text.sizes` as long sides ("1024 px", "2048 px", "4096 px" for FLUX 3), `genSize` makes
    the long side of the chosen aspect, a multiple of 16;
  - FLUX 3 thinks in tiers by area (`electron/main/providers/flux3.js` `FLUX3_TIERS`: 1k about 1 MP, 2k about 4 MP, 4k
    about 16 MP, 15 % slack, `tierOf`): 4096 at 16:9 is 9.4 MP and goes as 4k, 2048 at 16:9 is 2.4 MP and goes as 2k.
    The tier is right, the label says something else.
- **FLUX 3's own shapes:** 15 presets (`FLUX3_ASPECTS`: 21:9, 2:1, 16:9, 3:2, 7:5, 4:3, 5:4, 1:1, 4:5, 3:4, 5:7, 2:3,
  9:16, 1:2, 9:21), 14 on fal and WaveSpeed (no 9:21); the variants carry them (`limits.aspects`, `options.ratios` /
  `aspect_ratios`). The dialog cannot ask for 2:1, 7:5, 5:4, 4:5, 5:7, 1:2 or 9:21 except through *free*, where
  `shapeOf` takes the nearest preset.
- **A new empty canvas** (`renderer/editor/inpaint_canvas.js` `newCanvas`, the command `new_canvas`): width × height
  only, no aspects, no model. In an empty tab, a reference added through the prompt field first gets a white
  1024 × 1024 canvas.
- The small-box note of Generate new is measured at the requested size (`smallBoxes(boxes, [width, height])`).

## 2. The trap

Boxes drawn on a 1024 × 1024 canvas while the dialog stands on 16:9 go stretched, without a word; so do boxes drawn on
a 16:9 canvas while the dialog still holds the 1:1 of the last run. The placement the user drew is not the placement
the model gets.

## 3. The idea (the shape of the answer to the user)

1. **Generate new follows the document's aspect while boxes go** (the switch on and the document holds boxes): the
   dialog opens on the chosen model's preset nearest the document; a change of the aspect gets a note ("The boxes
   were drawn on 16:9; at 1:1 they go stretched.") instead of a silent stretch. Small, and worth doing without the
   rest.
2. **A New dialog with presets:** the model (and its provider), then an aspect from that variant's own list, then the
   size class (1k / 2k / 4k, or whatever the model calls its classes), and it makes a white canvas in exactly that
   aspect at the expected output size, so the small-box note and the placement of references are measured on the real
   frame. The document keeps the preset (saved with it), and Generate new opens on it.
3. **Size classes labelled per model:** the recipe's `text.sizes` gets labels (`{ px, label }` or a label map), with
   a price note where the provider documents one (the larger class costs more). Each model has its own system: FLUX 3
   1k / 2k / 4k by area, other models their own tiers or fixed sizes (to be read per recipe, not guessed).
4. **Optional, FLUX 3 on a new image:** a Text box as a New row with its words quoted in `desc` (BFL's tip: each line
   of text in its own row, the words quoted); a From reference box only after a live check of whether a layout row
   takes a `from` (the references go with Generate new). The refusal message for Text and From gets fixed either way.

## 4. Live check (with the user present: their key, their credits)

FLUX 3 Generate new with two New boxes on a 16:9 canvas at 2k, once on BFL direct: do the elements land in their
boxes, and does the answer keep 16:9? Then the same boxes with the dialog on another aspect, to see the stretch the
note in 3.1 warns of.

## 5. Open questions for the user

- The New dialog: a dialog of its own (File › New and the empty tab's hint), or the existing "New empty canvas"
  dialog extended?
- The canvas size: the expected output size (4k makes a 16 MP white canvas), or a working size in the right aspect
  (the boxes are fractions, so the size only changes the small-box note and the references' placement)?
- Does the model chosen at New select the recipe for the tab, or only fill the Generate new dialog?
- Presets for FLUX 3 first, or for every recipe with a text route at once?

## 6. Tests (by risk: Light, plus one Normal step)

Plain-Node: the aspect list per variant, the nearest preset to a document, the tier per class and aspect, the labels.
One gate step on the tiles backend: New with a preset makes the canvas of that aspect, Generate new opens on it, the
note when the aspect is changed with boxes on. One look in the app; the live check of §4.

## 7. Size (a guess from the reading, not measured)

3.1 a few hours; 3.2 with 3.3 about one session; 3.4 half a session plus the live check.
