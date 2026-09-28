# Custom brush tips

The paint and erase tools stamp either the built-in round dab or an imported *tip*: an 8-bit
coverage bitmap tinted with the paint colour. Tips come from Photoshop `.abr` files or plain
images and live in the *Tip* select of the tool options bar.

## Import

*Import* next to the select takes `.abr`, `.png`, `.jpg` and `.webp`. A `.abr` adds every
sampled tip it holds under the name the file gives it, with the file's spacing; the parametric
round tips Photoshop stores as numbers are skipped and counted in the status line ("12 tips
imported, 3 computed (round) tips skipped"), because the round dab already covers them. An
image with alpha is read as a cut-out (the alpha is the coverage); an opaque image as a scan
(dark paints).

The reader lives in the editor (`renderer/editor/inpaint_brushes.js`, from the node repo) and
reads versions 1, 2, 6 and 10. It follows GIMP and abrupng for the bitmaps and, unlike both,
parses the `desc` block for the names and spacings; the node's `DEVELOPMENT.md` §22 has the
format notes. Checked on 2026-09-12 against Photoshop 2026's own packs.

## Painting with a tip

- **Size** is the tip's long side; **Spacing** (shown with a tip) is the distance between
  stamps as a share of that size, preset from the file, 25 % when it has none. Opacity and a
  pen's pressure work as with the round dab; hardness does not apply, the tip has its own edge.
- **Follow stroke** turns the tip with the direction of travel, like a flat brush in the hand.
- The cursor shows the tip's box instead of the circle, the thumbnail beside the select shows
  the tip, and the trash button removes it from the list.
- The **eraser** stamps a tip too: pick one while the eraser is active.

## The tip popover

A click on the thumbnail (or on the word *Tip*) opens a popover under it
(`renderer/editor/inpaint_tippicker.js`, PLAN_0_1_31 §4 step 10): every tip with a stroke drawn
with it (an S-shaped wave that swells and thins like a pen's pressure, at the tip's spacing,
turned along the path when *Follow stroke* is on; the round dab at the active tool's hardness),
grouped by the file it came from, the last eight tips used as squares above (localStorage
`ipc.recentTips`, "round" for the built-in dab, 32 ids kept so a removed tip leaves room for
older ones; every `setBrushTip` counts, so the select and `set_brush` do too) and a search field
that keeps every tip whose name or file holds all the words typed. A click picks a tip and
leaves the popover open; a double click, or Enter in the search field, picks and closes (the
arrow keys move through the list from the active tip; Enter without a cursor takes a query's
first match, or only closes). Esc, a click beside it, the thumbnail or the word *Tip* again, the
canvas-only view or a tool without tips close it; a press on the picture only closes it and
paints nothing. The keys stay with the search field: a press anywhere in the popover keeps the
focus there, and a key from a button in it (after Tab) is never an editor shortcut.
*Import…* in it opens the same file dialog.

The previews never go through the stroke code (`tipStamp`, `dabMask` and `stampDab` keep one
cache entry each, which a preview would evict mid-stroke): each tip is drawn from a copy of at
most 96 px a side (`tip._mini`) and its preview is cached on the tip (`tip._preview`, keyed by
colour, spacing, *Follow stroke* and size); neither field reaches the brush store. The previews
are painted top to bottom in slices of 12 ms, so a library of hundreds opens at once.

## Where tips are kept

Imported tips are stored as `<id>.png` under `<userData>/brushes/` with a `brushes.json` index
(name, spacing, source file), through `electron/main/brushes.js` (IPC `brushes:list`,
`brushes:save`, `brushes:open`). `host.brushLibrary` in `renderer/editor/host.js` is the one
list every tab shares; a tab's import, removal or spacing change saves it and refreshes the
other tabs' selects. The ComfyUI node keeps its tips for the session only.

## Commands

`list_brush_tips` lists the round dab and every imported tip (id, name, size, spacing, source)
with the document's brush settings; `set_brush` sets the tip (by id or name), size, hardness,
erase hardness, opacity, the active tip's spacing, and *follow*. `docs/COMMANDS.md` has the
parameters.

## Gate

`python tools/brush_test.py`: first `node tools/brush_test.js`, which writes synthetic files of
every version (so nothing copyrighted is stored) and checks counts, names, spacings, PackBits,
alpha polarity and the dual-brush naming, plus the Photoshop packs on this machine when they
exist; then the app: the import through the editor's own path, a stroke with a ring tip
against the round dab through the real pointer handlers, an erase with a tip, the box cursor
and the thumbnail, the popover (opened by the thumbnail and the label, groups, previews drawn,
the recent squares, a click that picks and stays, the search, arrows and Enter, Esc, a click
beside it, a tool without tips, a tip added and removed while it is open), the commands,
persistence over a reload, removal.

## Not built

The tip transform a preset carries (`Angl`, `Rndn`, `flipX` / `flipY`) is read but not
applied; size and angle jitter; GIMP `.gbr` / `.gih` and Krita `.kpp`.
