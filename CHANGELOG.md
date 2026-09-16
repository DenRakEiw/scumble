# Changelog

What changed in each release, for the people who use Scumble. The release on GitHub carries
the section for its version; `docs/` and the commit history hold the technical detail.

## 0.1.15 — unreleased

- **The film looks panel and the 3D dialog no longer freeze the window on a large picture.** Half a
  second after every change to a document, the *Film looks* panel makes a small picture of it for its
  thumbnails; on a 15000 × 10000 document that picture used to be built entirely on the thread that
  draws the window, which stopped for **half a second** each time — the cursor did not move, nothing
  repainted — and left 185 MB of scaled-down copies behind. The same happened when the GLB dialog
  opened and when the magic wand looked at the whole picture first. All three now have the app's
  worker build what they need: the window is held for **47 ms instead of 700**, and 33 MB is kept
  instead of 221. The picture itself is unchanged, to the byte; it appears about half a second later
  than the frozen window used to show it.
- **For plugin authors**: `flatten({ maxSize })` and `flatten({ box })` take `settled: true`, which
  returns a promise and does the same thing. `docs/PLUGINS.md` → "A picture that does not freeze the
  window".
- **Screenshots for agents and prompt upsampling no longer stall a large picture.** The picture an
  agent asks for after a change (`screenshot` over MCP) and the one a language model is shown when you
  upsample a prompt are at most 1024 px wide, but they were made from the whole document at full size:
  on a 15000 × 10000 picture about **2 seconds** of a frozen window and **1.7 GB** of memory each
  time. With the tile engine on they now take **0.1 to 0.7 s** and read only the scaled-down picture.
  Edges in these small pictures come out slightly smoother than before; with the tile engine off
  nothing changes.

## 0.1.14 — 2026-09-15

- **Painting shows the stroke again while you paint.** In 0.1.13 the brush, the eraser (also on a
  layer's mask), the clone and heal brushes, the gradient and a dragged rectangle, ellipse or
  freehand shape showed only the first dab while the mouse button was down, and the whole stroke
  appeared when you let go.
  The stroke itself was always painted correctly; only the screen was not redrawn during it. It
  happened with the tile engine on and off, at every zoom and on every picture size.
- **The Settings dialog closes again.** In 0.1.13 *Close* could answer "enter a valid value, the
  nearest are 464 and 528" and stay open: the *Tile atlas* box under *Settings › Rendering*
  did not accept its own default of 512 MB. The three memory boxes there now take any whole
  number of MB, including a value an earlier version stored, and *Generate a new image* no
  longer shows a width or height above the 8192 px it asks for on a very wide picture.
- **ToAPIs as a provider.** One key from [toapis.com](https://toapis.com) runs GPT Image 2 and
  2.5 (Flare, Sunburst), Nano Banana 2, 2 Lite and Pro, FLUX.2 pro and flex, Seedream 5 lite and
  pro and Qwen Image 3.0. ToAPIs is listed first under *Settings › API providers* and in each of
  these models' provider choice, in *Generate a new image* and in `list_recipes`; nothing moves
  to it by itself, every model keeps running where it ran until you pick ToAPIs for it.
  - **Not tried against the real service yet.** It is built from ToAPIs' documentation; if a run
    fails, *Help › Console › Copy all* has the task id and ToAPIs' own message.
  - **What leaves your machine:** the crop, the mask and the reference layers are uploaded to
    ToAPIs and get public `files.toapis.com` addresses for the run, as the service requires.
  - **Channel** in the model's settings: *official* is the model maker's own cloud and the
    default where ToAPIs has it. *vip* and *standard* cost a fraction of it. On GPT Image 2 only
    *official* takes your selection as a real mask; the cheaper channels, like every other model
    on ToAPIs, edit the whole crop, and Scumble keeps only the selected part of the answer.
  - A crop over ToAPIs' 10 MB upload limit is sent as a JPEG, and so is a reference without
    transparency (the *Original* copy of the crop is one). A mask, or a cut-out reference, that
    large is refused before anything is sent, with a note to set *Highres fix* lower, turn
    *Original* off or use a smaller reference layer.
  - *Resolution* on *auto* picks the cheapest size tier that still covers your crop.
  - Seedream on ToAPIs takes no picture longer than 3:1, so a thin selection is sent with more of
    its surroundings above and below it.
  - A run that ToAPIs has already accepted is not given up over one failed status check or
    download; if the download keeps failing, the message names the task, whose picture stays in
    the ToAPIs console for a day.
  - *check balance* next to the stored key shows what the key has left, free of charge.
  - The key link carries the author's referral code.
- **Prompt upsampling on the ToAPIs key:** with a ToAPIs key stored, Gemini 3.8 Flash, Claude
  Haiku 4.5 and GPT-5.6 Terra appear at the top of the upsample list (about a tenth of a cent a
  rewrite), also not tried against the real service yet. A refused key, an empty balance or a
  rate limit is reported as such; the prompt is only rewritten without the picture when ToAPIs
  refuses the picture itself, and the status line then says *text only*.
- **Switching models starts from that model's own settings.** Picking another API model used to
  keep a setting of the same name from the model before, so a *Channel* or *Quality* chosen for
  one model could silently change how the next one ran. A model you switch to now starts from
  its own defaults (switching back does too), and a document saved by an earlier version shows
  its model's defaults once.
- **Generate a new image sends the aspect ratio you picked** (3:2, 21:9 ...) instead of the
  rounded pixel size, which some models read as a slightly different ratio.

## 0.1.13 — 2026-09-15

- **The tile engine is on.** Scumble now keeps the picture, every layer, every mask and the
  selection in small tiles of 256 px, and the screen draws only the tiles the view shows, at
  the zoom you see them. It is what the installed app runs from this version on; the bullets
  below marked *(tile engine)* are the work that got it there, and their numbers compare the
  tile engine before and after that work. What it changes on a very large picture is where the
  memory goes: a 15000 × 10000 picture with three full-size paint layers, a colour-matched result
  and a film look held about 7.5 GB in the graphics process (much of it on the graphics card,
  which ComfyUI uses too) and 0.7 GB in the window's own process; with the tile engine it is about 2 GB and 4.5 GB.
  Several such pictures open at once add up in the window's process (three came to over 10 GB
  and made panning slow), so close the tabs of large pictures you are not working on. On that
  picture panning at 1:1 takes about 3 ms a frame, a brush or mask dab about a millisecond, and
  after a flip or *Mask from selection* the screen shows a coarse picture at once and the sharp
  one within about a second; without a filter layer in the picture, zooming in to 1:1 draws its
  first frame in about 20 ms.
  - **To switch it off**, untick *Settings › Rendering › Tile engine* and press *Restart now*:
    every layer is then one canvas as large as the picture again, as in 0.1.12. `--no-tiles` on
    the command line does the same for one start, `--tiles` the opposite; the row says when the
    command line decides instead of the box. *Restart now* saves the open pictures first, your
    last strokes included, and when an update has already been downloaded it installs that too.
  - **Still slow, or still making full-size copies, with it on** (later steps): the smudge brush
    on a very large picture (0.4 to 0.75 s for every mouse move at 15000 × 10000); the magic wand
    when its region reaches across the whole picture (the window stops for several seconds) and
    inverting the selection (about a second), both much longer than with the tile engine off;
    renders, exports, the object tool (O), prompt upsampling and the `screenshot` command, which
    still build the whole picture: at 15000 × 10000 that holds the window for a few seconds (a
    little longer than with the tile engine off), and with a film look in the picture for around
    ten seconds, about as long as with it off; placing a film control point where a film look
    lies below it, which flattens the picture below the points (about 5 s at 15000 × 10000);
    removing a background, *select by text* on a layer, *select from layer*, and the autosave 15 s
    after you changed a full-size layer, which each make a full-size copy of that layer (up to
    about a quarter of a second at 15000 × 10000, where the tile engine off uses the layer
    itself); and the first second after a change to a whole layer or mask, while the sharp
    picture comes in.
- **The screen draws the tiles themselves (tile engine).** The GPU compositor now keeps the tiles
  the view shows in an atlas of its own and draws them directly, instead of building a full-size
  copy of every layer in memory and a second one on the graphics card first. Zooming a
  15000 × 10000 picture back to 1:1 took a second before and takes 35 ms now, and the graphics
  memory the screen needs for such a document drops from over a gigabyte to about 90 MB.
  *Settings › Rendering › Tile atlas* says how much graphics memory it may use (512 MB by
  default).
- **And so does everything else on the screen (tile engine).** The selection's outline and its
  tint, the navigator, and every drawing path the graphics card cannot take (a filter layer in
  the picture, a live brush stroke, a transform, the before/after view) now read the tiles the
  view shows instead of a full-size copy of the layer. On a 15000 × 10000 picture panning at
  1:1 with a film look in the stack went from 41 ms a frame to 2.5, the opacity slider from 56
  to 8, a selection change from 78 to 21 and undo from 66 to 18, and the copies the display
  holds fell from 956 MB to 196.
- **Fewer full-size copies behind small things (tile engine).** Peeking at the base, dragging or
  scaling a full-size layer, the eyedropper and the magic wand on a picture with a masked layer,
  and a filter layer with a mask each made a full-size copy of a layer (572 MB on a
  15000 × 10000 picture, twice that for a masked one) before they drew. They read the tiles now:
  the peek's first frame went from 558 ms to 60, a layer drag's first frame from 425 ms to under
  a millisecond, the eyedropper on a masked layer from a second to 20 ms, and the magic wand with
  a masked full-size layer in the picture from 1.3–1.8 s to about 0.3 s. While a brush stroke
  runs on a layer, its row in the layer list shows the layer as it was before the stroke.
- **A brush stroke no longer pauses on a large picture.** The live preview of a stroke used to
  be built as a copy of the whole layer, filled from a full-size copy of its pixels: on a
  15000 × 10000 picture the first dab of every stroke stopped the window for about a fifth of
  a second and cost a gigabyte. It is now composed only in the part of the picture the window
  shows, at the resolution it is shown at. The first dab takes about a millisecond, and the
  copies the display holds while you paint drop by 1.1 GB with the tile engine and by 570 MB
  with it off. While you paint zoomed out, the soft edge of the stroke is now drawn at the zoom
  you see instead of being shrunk from the full-resolution stroke; the pixels the stroke finally
  writes are unchanged.
- **Painting right across a large picture.** A stroke that crosses the whole picture used to make
  two more copies of itself, each as large as the area it spans, and to apply itself to the layer
  in one piece. On a 15000 × 10000 picture a stroke of forty dabs across the diagonal took 870 ms
  of drawing and 1.3 s to apply, and held 1.1 GB while you drew it. It is now clipped and applied
  in bands of 1024 px, and only in the bands a dab really touched: 29 ms of drawing, 280 ms to
  apply (measured with the tile engine), and those 1.1 GB are gone. The result is the same picture.
- **A stroke only remembers where you painted (tile engine).** The buffer a stroke is drawn into
  used to be a rectangle around everything the stroke had touched, so a line from one corner of a
  15000 × 10000 picture to the other held 560 MB for a line a few hundred pixels wide. It now
  keeps only the tiles the brush actually reached: 26 MB for that same stroke, and no
  copying while it grows. Nothing changes for the gradient tool, which covers the whole layer by
  its nature and keeps the buffer it had.
- **Layer masks cost almost nothing now (tile engine).** A layer with a transparency mask used to be
  kept as a second, complete copy of itself with the mask multiplied in, rebuilt from scratch every
  time you changed either. On a 15000 × 10000 picture that copy and what it was built from came to
  1.86 GB, and one dab of the mask brush stopped the window for a quarter of a second. The mask is
  now applied while the picture is drawn, from the same tiles as everything else: that dab takes
  about a millisecond and the 1.86 GB are gone. When a *whole* mask or layer changes at once (mask
  from selection, a flip, a filter applied to the layer), preparing every tile for the screen no
  longer adds a quarter to half a second on such a picture: the next frame shows a
  coarse picture of the new tiles, and the sharp one follows within about a second. The change
  itself still holds the window for most of a second on a 15000 × 10000 picture (0.8 s for a
  flip, 1.2 to 1.4 s for mask from selection).
- **Growing, shrinking, feathering and inverting a selection.** These four used to move the whole
  selection through a background worker whatever you had selected — on a 15000 × 10000 picture,
  600 MB of it, three times over. They now work on the area the selection covers plus what the
  operation reaches past its edge. With the tile engine, grow went from 4.2 s to 1.3–2.3, shrink
  from 3.3 to 1.5–1.8, feather from 2.4 to 0.6–1.0 and inverting from 2.7 to about 1.0 (each
  range spans the run when the change was made and the last run before this release). Grow and
  shrink keep the window responding for most of that time, feather holds it for about half, and
  inverting for all of it. With the tile engine off these were already quicker and gain as well (grow 2.3 s to 1.3). The smaller your selection, the bigger the difference.
  (The magic wand and the bucket are not part of this.)
- **A control point takes the colour under it, before its own effect.** A point of the film pack's
  control points changes the pixels whose colour is close to the colour it was placed on. That colour
  came from a small copy of the picture that the last full-resolution render had left — so after a
  change below the points it could be the colour from before that change — or else from the whole
  flattened picture, with the points' own adjustment and the layers above them in it. It is now the
  colour of the picture under the points layer where you place or move the point, read from a small
  area around it instead of the whole picture: with the tile engine, on a 15000 × 10000 picture, adding a
  point takes about a tenth of a second. Under a filter whose result depends on the whole picture (a
  film look's halation, a vignette, a frame) the picture below the points is still flattened, as
  before, so that the colour is right there too. Points you placed before keep their colour. And a
  point's effect now stays where the point is when you zoom in: a zoomed-in view showed it shifted
  by the distance of the view's corner from the picture's (exports were right).
- **The sample plugin reads only what it needs.** Its mean colour of a selection and *Selection to
  new layer* read the selection's area of the picture, and its colour probe a square of 256 px
  around the cursor, instead of the whole flattened picture: with the tile engine 2.6 s to 0.06–0.3 s for a
  1000 px selection on a 15000 × 10000 picture. With a filter that reads the whole picture (a film
  look's halation, a vignette) they still flatten it, as before.

## 0.1.12 — 2026-09-14

- **No visible change: the editor's pixel access goes through one interface.** Until this
  release the editor reached into the pixels of layers, layer masks, the selection and the
  picture from several hundred places, each in its own way. Every one of those reads and
  writes now goes through one interface, and your pictures come out exactly as before (apart
  from the fixes below, which fell out of it and of its review). This is the groundwork for the tile engine
  that will make very large pictures light on memory. For plugin authors: a layer's pixels are
  `layer.px` and its mask `layer.maskPx`; `rawLayer(key).canvas`, `.mask` and
  `doc.editor.selection` still work in this release and log a warning (`docs/PLUGINS.md`).
- **Smudge, fill and clear work the same on every layer.** On a layer you had flipped or
  turned by 90°, the smudge brush put its paint at the mirrored or turned spot instead of
  under the brush. On a layer made by *Merge down*, *Fill selection* blended the colour with
  the merged layer's blend mode and opacity, and clearing the selected pixels removed only
  part of them. After a rotate, distort or warp was applied, a later fill, clear or smudge on
  that layer came out slightly different at its soft edges. Each of these came from drawing
  settings that the flip, the merge or the transform left behind on the layer.
- **Undo puts a flipped, turned or merged layer back the way it was.** Undoing a fill, a
  clear, a smudge stroke or a plugin's change on a layer you had flipped or turned by 90°
  brought the layer back mirrored or turned, and on a layer made by *Merge down* with an
  opacity below 100 % it came back see-through at that opacity. The same leftover drawing
  settings were the cause.
- **Undo and redo pressed quickly in a row land in order.** Holding Ctrl+Z or double-clicking
  the undo button could leave a layer half undone (two fills undone showed the first fill) and
  the redo steps wrong. An undo right after *Grow*, *Shrink*, *Feather* or *Invert* waits for
  that operation now and takes it back, instead of undoing the step before it and then being
  overwritten by the late result.
- **Undoing further back no longer brings undone changes back.** After a fill or clear on a
  layer mask was undone, undoing an older layer step (a duplicated, moved or removed layer)
  showed the fill again.
  The same happened with a text layer's size, font or content and a filter layer's sliders:
  undoing past an older layer step put back the value that had just been undone.
- **Opening another picture starts a fresh history.** When the new picture had the same size
  as the old one (the Load button, a Ctrl+drop, the `load_image` command), Ctrl+Z put the old
  picture's layers, or after a crop its whole picture, back on top of the new one.
- **The undo history keeps its full length.** After *New canvas*, *Generate new* or opening a
  picture of another size, the old document's undo memory stayed counted, so a tab that had
  seen large strokes kept only one undo step from then on. After an undo, the next edit also
  threw away older undo steps that would still have fitted.
- **Closing a tab frees its memory.** Every closed document stayed in memory with its layers
  and undo steps until Scumble was quit, which on large pictures was gigabytes per tab.
- **A restored document keeps its selection.** A document above 1 MP that was saved with a
  selection (the next start, a reopened workflow in ComfyUI) came back with the selection's
  pixels but treated as nothing selected: no marching ants, *Generate* cropped the whole
  picture, and the next selection undo emptied it. Undoing a crop or an extended canvas could
  do the same while zoomed out.
- **The selection brush shows its whole stroke while you paint zoomed out.** Parts of a fast
  stroke only appeared when the button came up.
- **An edit made right after Ctrl+Z is no longer lost.** On a large picture an undo of a fill,
  a smudge, a text or a mask change takes a moment to load, and a stroke, a selection or a new
  layer made in that moment was wiped out when the undo landed; the next Ctrl+Z then produced
  a picture that had never existed. Such an undo now stops and says so in the status line
  (press Ctrl+Z again), and the same goes for an undo pressed while *Grow*, *Feather* or
  *Invert* is still working when you draw meanwhile: it no longer takes back your new stroke.
- **Ctrl+Z during *Extend*, *Crop*, *Resize*, *Merge down* into the base or *Flatten* takes that
  operation back.** Pressed while the new picture was still being prepared, it undid the step
  before instead, and could lose a stroke for good or leave a merged layer both in the picture
  and in the layer list.
- **Flatten can be undone.** It had no undo step, and undoing an older layer step afterwards put
  the flattened layers back on top of a picture that already contained them (a multiply layer
  applied twice).
- **A restored document keeps its selection after the next save.** When the document was saved
  while it was still loading (Scumble's autosave shortly after the start, ComfyUI saving the
  workflow), the selection was on screen but every later save stored an empty one, so it was gone
  after the next restart.
- **Smaller undo fixes.** Ctrl+Z while the mouse button or pen is still down (a stroke, a
  marquee, a move) is ignored with a note in the status line; it used to take back that very
  gesture's step, so the finished stroke or selection had no undo step, and on a layer mask it
  could remove the mask under the stroke. An undo step whose picture could not be saved says so
  in the status line instead of silently doing nothing. Cancelling a text edit (Esc) or closing a
  tab with a text edit open no longer leaves a copy of the text layer in memory.
- **The `load_image` command reports a picture that could not be loaded.** In a tab that
  already showed a picture, a file that failed to load was answered with the old picture's
  size, as if it had worked; the error from the status line is returned now.
- **No visible change: a second pixel store, switched off in the installed app.** Scumble can
  keep a picture's layers, masks and selection in small tiles instead of one canvas each; that
  is the next step towards very large pictures that are light on memory. The installed app keeps
  using canvases as before, so nothing changes for you in this release; the tile store is on only
  when Scumble is run from its source, where it is tested alongside the canvases.
- **For plugin authors:** inside `px.drawInto(rect, ctx => ...)` compose on the transform the
  context comes with (`scale`, `translate`, `save` / `restore`) and never set one; with the tile
  store it is not the identity. Keep the callback synchronous (one that returns a promise
  throws) and do not read pixels back from `ctx`. Clip only to rectangles on whole pixels, and
  do not give a layer pixels of your own or from another document: replace them through
  `setPixels` or `addLayer`.
  The full list of rules is in `docs/PLUGINS.md`.

## 0.1.11 — 2026-09-13

- **The editor is built from the Scumble repository now** (this part changes nothing you
  can see). Until
  this release the editor's code lived in the ComfyUI node and was copied into the app with
  a list of patches. Scumble is its home now, and the node gets a build of it, so a fix made
  here reaches both without a patch in between.

- **Large pictures: the hitches between strokes are gone, and a stroke no longer costs a
  layer's worth of memory.** On a 15,000 px picture a selection change, its undo and the
  scan for its bounding box used to hold the window for 50 to 750 ms, because each one
  copied or read the whole selection; they take a few milliseconds now (the undo copies only
  the selection's extent, the box is read in strips from a known edge, and a subtract keeps
  the old box as its starting point). Undoing a stroke refreshes only what it changed instead
  of rebuilding the layer's display levels and every thumbnail, and a change that cannot have
  touched a colour-matched layer no longer makes that layer rescan its statistics. A brush,
  eraser, clone, gradient or shape stroke draws into a buffer the size of what it touches
  instead of a canvas the size of the layer (three of them, 1.8 GB on that picture), the live
  preview updates only around the dab, and the preview canvas is given back after the stroke.
- **The magic wand and the bucket look at the region, not the whole picture.** A coarse pass
  finds where the region is, the fine pass floods only that box at full resolution and widens
  it where the region reaches its edge, so a one pixel bridge still joins what it joins. The
  bucket's undo step is a copy of the box. The eyedropper composites one pixel.
- **Zooming into a large picture no longer uploads whole layers to the graphics card.** The
  compositor keeps a window of each layer around what the view shows, with a margin so a pan
  inside it uploads nothing; at 1:1 on a 24 MP picture two layers hold 69 MB instead of 183.
- **The memory watch sees the whole graphics card.** Settings › Rendering shows how much of
  the card is in use by everything (ComfyUI's models above all) and has a row for how much to
  keep free (2 GB by default); when the card is that short, the caches of background tabs
  and the front tab's textures are released. *Free VRAM* releases the caches of every tab.
  The `status` command reports the card's numbers.
- **The Film looks panel no longer flattens the whole picture at full size for its
  thumbnails** on every change (two seconds on a 15,000 px picture); plugins can ask
  `flatten({ maxSize, box })` for a smaller or partial composite.

## 0.1.9 — 2026-09-12

- **The model folder is scanned, and what it holds is linked.** Point Settings › Helpers at
  a ComfyUI `models` folder (or press the new *Scan folder*) and every ONNX file in it that
  belongs to one of the helper models is found and used whatever its name or subfolder: the
  exporter's own file names, a Hugging Face snapshot such as `RMBG-2.0/onnx/model.onnx`, a
  file recognised by its exact size. A linked model shows where its file is and gets an
  *Unlink* button instead of *Remove*, so nothing in your ComfyUI folder is ever deleted.
  The weights the ComfyUI nodes themselves use (`.safetensors`, `.pt`, `.pth`) are listed
  per model too, with the plain statement that they cannot be loaded here, because the
  in-app helpers run on ONNX Runtime and those are PyTorch files; the ONNX download stays
  the way to get such a model. A line above the list sums the scan up.
- **Escape closes the Settings dialog and the "Generate a new image" dialog.** The editor's
  own key handling swallowed the key before the dialog saw it, so the dialogs could only be
  closed with the mouse. A key pressed inside any open dialog now stays with that dialog.
- **SVG files can be opened and added as layers.** A vector drawing has no pixel size of its
  own, so opening one asks for the size (its own when it declares one, else 2048 px on the
  long side, the ratio kept) and rasterises it on the way in; as a layer it is rasterised to
  fit the document, so it stays sharp. `load_image` takes `width` / `height` for it. Before,
  an `.svg` silently failed to load.
- **An EU AI label in one click.** The new *AI label* panel in the Image pane (a built-in
  plugin) places the European Commission's icon for AI-generated or AI-modified content as a
  layer: pick *AI GENERATED*, *AI MODIFIED* or the bare mark, white on black or dark on white,
  a solid or translucent pill, the size as a share of the picture's width, one of nine
  positions with a margin, and the opacity. It is an ordinary layer afterwards (move and
  scale it with T); *Add label* again replaces it. Also in the Plugins menu and as the
  `ailabel.add` command for agents. The icons are the Commission's own, free to use without
  attribution; the label says the picture was made or changed by AI and nothing more.
- **Custom brushes from Photoshop `.abr` files, kept across restarts.** *Import* next to the
  *Tip* select (paint and erase tools) reads every sampled tip of a pack with its own name and
  spacing, checked against Photoshop's own brush packs; the parametric round tips are skipped
  and counted in the status line. A tip gets a *Spacing* slider, *Follow stroke* (the tip turns
  with the direction of travel), a thumbnail, the cursor as the tip's box, and a trash button;
  the eraser stamps a tip too. Imported tips are stored under the app's data folder and are
  there again after a restart, in every tab. Agents get `list_brush_tips` and `set_brush`.
- **3D objects in the picture.** *Plugins › Place 3D object (.glb)...* (or the new *3D object*
  panel) opens a dialog with your picture as the backdrop: drag to turn the model, Shift+drag
  to move it, the wheel to scale it, sliders for distance, focal length and light, a ground
  shadow if you want one. *Place* renders it into an ordinary layer at the picture's
  resolution; select it and *Generate* with a denoise below 1, and the model paints it into
  the scene. A tick adds a depth layer (role control) for a depth ControlNet. The object
  stays editable: *Edit* in the panel reopens the dialog and replaces the layer. Agents get
  `glb.place` and `glb.edit`. Draco / KTX2 compressed files are not supported yet.
- **Fixed: plugins could not read their stored settings back** (the film pack's group choice,
  the AI label panel's last settings); they do now.
- **A Normalise filter layer.** *Colours towards the mean* evens out the tint of a layer while
  its light stays, *Everything towards the mean* flattens all values, *Stretch levels* pulls
  each channel to the full range; the Amount slider mixes it in. GPU and CPU paths.
- **The export can put the picture in a frame.** A *Canvas* row under Size: a width and
  height, where the picture sits (nine positions) and what fills the rest (transparent,
  white, black). Bigger adds a margin, smaller crops. The `export` command takes
  `canvas_width`, `canvas_height`, `anchor` and `fill`.
- **API results default to 2K** where the provider offers it (Nano Banana 2 and Pro on
  Google, fal, Replicate, WaveSpeed and Comfy Cloud; GPT Image on WaveSpeed; Seedream 5 Pro
  on WaveSpeed). It was 1K, which threw away most of what the crop carries.
- **Scaling a layer snaps to the picture's edges.** Dragging a corner or an edge of a layer
  with the transform tool now snaps the dragged edge to the canvas edges, its centre and the
  guides, like a magnet, so a layer pulled out to the full picture lands exactly; Alt keeps
  it free. Moving already did this.
- **A console and a log file.** *Help › Console* (Ctrl+Shift+L), or a click on the status
  line, opens the log: everything the app, its providers and helpers reported, errors first,
  with a level and a text filter, *Copy all* and *Open folder*. The same lines go to
  `logs/scumble.log` in the app's data folder (rotated at 1 MB, two files kept). A failed
  provider run is logged with the model, the request's shape and the full error, never the
  key or the pixels; the status line shows the full text as a tooltip. Agents read it with
  `read_log`.
- **Comfy Cloud failures now say why.** The job status said only "error"; the node's own
  message (safety filter, missing credits, a bad input) is read from the job's history and
  shown in the status line.

## 0.1.8 — 2026-09-11

- **Fixed: a whole layer vanished from the picture after an erase or brush stroke that was
  nowhere near it.** Zoomed out, the screen is drawn from a reduced copy of each layer, and
  the stroke refreshed that copy inside the stroke's rectangle with a drawing mode that
  Chromium applies to the whole copy: everything outside the rectangle was cleared. The
  layer's pixels were never touched (exports, the thumbnail and a re-zoom still had them),
  only the picture lost them, and erasing looked like it took rectangular chunks out of a
  layer or removed a result layer entirely. The reduced copy is now refreshed inside the
  rectangle only.
- **Fixed: a click with the rectangle or ellipse tool left a small selection behind.** It was
  meant to clear the selection, and on a normal-sized image it did. Zoomed far out it did
  not: one screen pixel is many image pixels there, so a hand that wobbled by a single pixel
  drew a tiny rectangle right under the cursor instead. On a 15,000 px image that was a
  dozen image pixels wide, and since brush and eraser are clipped to the selection, retouch
  stopped working with no visible reason. The drag is now measured in screen pixels, so the
  same gesture means the same thing at every zoom.
- **The *API size* row is called *Highres fix* now**, and its choices are named so they read
  without hovering for a tooltip: *Maximum*, *2x crop*, *4x crop*, *Target size* and
  *Off (crop size)*. The row decides how far the crop's resolution is pushed up before it
  goes to the provider; nothing about what it does has changed.

## 0.1.7 — 2026-09-11

- **Transparent results from the OpenAI image models.** GPT Image 2.5 Flare, 2.5 Sunburst
  and 2 can answer with a cut-out instead of a picture: a subject on a fully transparent
  ground. Set *Background* to `transparent` in the Settings panel and the result layer keeps
  the model's own alpha channel, so a logo, a product shot or an object arrives ready to
  place over anything. "Generate a new image" has a **transparent background** tick for the
  same thing, and the base image then keeps its alpha. Colour match is skipped for such a
  run, and the status line says plainly when the model returned no transparency after all.
- **A prompt template for it.** *Transparent asset* writes the cut-out wording the model
  needs (clean alpha edges, no backdrop, no drop shadow at the border) around your request.
  It is offered for the OpenAI models.
- **The rest of the OpenAI image parameters.** File format (PNG, WebP, JPEG), compression
  for the two lossy ones, and moderation are settings rows now. A transparent JPEG is sent
  as a PNG rather than losing the cut-out, and `input_fidelity` is no longer sent to
  GPT Image 2, which always works at high fidelity anyway.
- **GPT Image 2.5 goes out at up to 3840 px** instead of 2048, inside the model's own rules:
  both edges a multiple of 16, a ratio no steeper than 3:1 and a total between 655,360 and
  8,294,400 pixels. A small selection is now grown to that lower bound instead of being
  refused.
- **Fixed: the prompt templates were missing from "Generate a new image"** until the
  Settings dialog had been opened once in the session. They are loaded at start now.
- Photoshop and Krita are no longer named in the feature list, the model descriptions or
  the tooltips.

## 0.1.6 — 2026-09-11

- **API runs go out at the size the provider really takes.** Until now every API run sent a
  1024 px crop, whatever the model could have handled, because one number in the Generate
  section governed both the local and the API path. Each model now carries its own ceiling
  and the crop is emitted against that: FLUX.2 and FLUX.1 Fill at most 1440 px (2048
  answered with an error), GPT Image at most 2048 px inside its pixel budget, Seedream 5
  under an area budget instead of a side limit (4 megapixels for pro, 16 for lite), so a
  wide selection goes out well past 2048 px, the rest at a conservative 2048 until the
  provider's own number is confirmed. The new **API size** row
  under the Generate section chooses how the ceiling is used: *Provider max* for the best
  the model offers, *2x crop* and *4x crop* for a high-res fix that sends a small selection
  at twice or four times its own resolution, or the two older behaviours. Local ComfyUI runs
  are untouched and keep using Target.
- **A shape tool (Y).** Rectangle, ellipse, polygon, polyline, Bezier curve and freehand path,
  filled with the paint colour, outlined in a colour and width of their own, or both. Rectangle,
  ellipse and freehand are dragged out, and Shift keeps them square while Alt draws from the
  centre; polygon, polyline and Bezier are clicked point by point, and a drag while clicking a
  Bezier point curves the line into it. Enter or the first point finishes, Backspace takes one
  point back, Escape cancels. The shape lands on the active layer, is held inside the selection
  like every brush, follows the opacity slider and is one undo step. Rectangles take a corner
  radius. Until now this needed a selection and a bucket fill.
- **Export can save smaller.** A Size row under the Export section takes a percentage of the
  document, or a free width and height that keep the aspect ratio, and JPEG and WebP got a
  quality field next to it. A large reduction is walked down in halving steps instead of one
  jump, which keeps fine detail from breaking up. The status line names the size that was
  actually written. PSD and ORA always keep the full size, because their layers would each
  have to be scaled. The `export` command and the MCP tool take `scale`, `width`, `height`
  and `quality` for the same thing.
- **Seven more models.** Z-Image Turbo (fal, with a real mask inpainting endpoint),
  Ideogram 4, Grok Imagine 2.0 and Reve 2.1 for editing; Krea 2, Recraft V4 and Z-Image base
  make images from the prompt alone, so they appear in "Generate new" and the Generate
  button says where they belong. None of them has run against the live API yet, as with
  every other provider in Scumble.

## 0.1.5 — 2026-09-10

- **MCP clients that refused to talk to Scumble now connect.** Before the app itself starts,
  Electron writes one empty line to the channel the client is listening on, and a client that
  follows the specification to the letter counts that as a broken message and drops the whole
  session. Scumble is now started through a small launcher that keeps the channel clean.
  Help › Copy MCP registration puts the right line for Claude Code or the JSON block for
  Claude Desktop on the clipboard, with the paths of your installation filled in - nobody
  should have to type those by hand. An already working registration keeps working.
- **Prompt upsampling on your own machine, without a key.** Settings › Local /
  OpenAI-compatible endpoint takes the address of a server that speaks the OpenAI chat API -
  Ollama, LM Studio, vLLM, a proxy - and a model name, and that model joins the Upsample list
  in the Prompt section next to the ComfyUI nodes and the API models. Test asks the server
  which models it has and offers them in the field. A model that can see gets the same crop
  the other backends get; one that cannot is asked again without it, and the status line then
  says "text only" so you know the rewrite is based on your words alone.
- **Generate a new image from the prompt alone.** *Generate new* in the top bar opens a
  dialog: where it runs (your ComfyUI or an API provider), which model, the prompt with the
  upsample button beside it, aspect ratio and size, and the seed. The answer becomes the
  tab's image, so you can start from nothing and then edit as usual. On an API provider
  nothing but the prompt is sent, no blank canvas travels with it. Providers that can do
  this: OpenAI, Google, Black Forest Labs, fal.ai, Replicate and WaveSpeedAI; Comfy Cloud
  cannot and says so.
- **The size list follows the model.** Nano Banana and the other Gemini image models are
  offered up to 4096 px, because that is what they take; OpenAI's stay at their two standard
  sizes. Before, every model got the same list that stopped at 2048. The list has nothing to
  do with whether a key is stored.
- **Prompt templates as Markdown files.** How the language model rewrites your prompt is no
  longer one fixed rule. Four come with the app - a rich scene, a photographic one, a tag
  list for SDXL-style models, and a short edit instruction - and you can write your own,
  import them under Settings › Prompt templates and pick one in the Generate new dialog or
  for the editor's Upsample button. A template is a plain .md file with a short header, so a
  prompt style can be kept and passed on like any other document. See docs/PROMPTS.md.
- **New asks for width and height in two boxes.** One field that wanted "1440x1440" was
  awkward to type and easy to get wrong. There are two number boxes now, with a *Keep the
  ratio* tick if you want the second to follow the first.
- **Fixed: the size in that dialog could not always be typed.** The dialog put the cursor in
  the field, and the click that had opened it took the cursor straight back to the canvas.
- **A click deselects again.** Clicking inside an existing selection with the rectangle
  or ellipse tool started moving its outline and kept the selection even when nothing
  moved. A lasso click did nothing at all. Both clear the
  selection now, so you can start a new one straight away. The selection brush is unchanged:
  a click sets a dab there, which is what a brush does in both programs too.
- **The selection outline stays visible on a white image.** While you drag a rectangle,
  ellipse, lasso or polygon, the outline was a white dashed line and vanished on anything
  light. It is now drawn black first with the white dashes over it, the same two-colour trick
  the finished selection already used.
- **Copy and paste whole layers, also from one tab into another.** Ctrl+C with nothing
  selected used to refuse; it now copies the whole active layer, Ctrl+X cuts it out, and
  Ctrl+V pastes it as a new layer in any tab. The layer row also has a duplicate button now,
  for what Ctrl+J could always do.

## 0.1.4 — 2026-09-10

- **Fixed: the app got slower the longer you worked in it.** Opening and closing several
  large images in one session left every one of them in memory, with all of its layers. After
  four 12k documents a slider drag cost 50 ms per step instead of 9, panning stuttered, and
  the graphics card was holding 19 GB it could not use for anything. The documents are let go
  properly now: the same four rounds end within a few percent of the first one, and with
  35 MB left over instead of 19 GB. The cause was in the plugin system, so it also applies to
  any plugin you write yourself.
- **Filter layers stay on the graphics card.** A stack of filter layers used to hand the
  picture back and forth between the processor and the card once per layer. It now stays
  there for the whole chain: five filter layers on a 24 megapixel document cost 1.5 ms a
  frame instead of 2.9, and a film look with halation and grain 2.7 ms instead of 3.4. The
  picture is unchanged, checked layer by layer including opacity, blend modes and masks.
- **Free VRAM gives the caches back too.** The button in the toolbar already unloaded the
  helper models; it now also releases the filtered copies, the display pyramids and the
  textures the current documents are holding, and says how many megabytes that was.
- **Background tabs release their caches when memory runs short.** Above a limit you can set
  in Settings › Rendering (3 GB by default, 0 switches it off) the tabs that are not in front
  give up what they can rebuild. The document in front is never touched, and neither is a tab
  that is working on something.
- **Fixed: painting or erasing on a layer snapped back.** The stroke was in the image the
  whole time - it was saved, exported and rendered with - but the screen kept showing the
  layer as it was before. A regression of the graphics-card compositor in 0.1.3.
- **Fixed: the colour match slider did nothing.** On the same path the match had nothing to
  measure itself against and quietly stayed at zero, whatever the slider said. Also from
  0.1.3, and also only on screen: a flatten or a run applied the match correctly.
- **A reference image keeps the layer's mask tools.** Turning a layer into a reference used
  to take away background removal (RMBG) and the mask buttons, which is where a reference
  needs them most. The selected reference now has the same row as an image layer, and the
  cut-out travels into the image that is sent with the crop.

## 0.1.3 — 2026-09-10

- **The view is composited on the graphics card.** Every layer is now stacked in one shader
  pass instead of being drawn one at a time on the processor. On a large window with a
  dozen layers the slowest frames went from about 10 ms to 0.2 ms, so panning and zooming
  stay smooth where they used to stutter. The picture is unchanged: the new path was checked
  against the old one pixel by pixel over every blend mode, a masked layer, colour match and
  text, and agrees to within one level of 255.
- Filter layers, a running brush stroke, a transform, the compare split and every export
  keep the previous path, and so does any machine without WebGL2. Nothing depends on the
  new compositor being available.

## 0.1.2 — 2026-09-10

- **High-resolution editing is a different program.** Working on 6k to 12k images used to
  mean waiting after every action; the whole drawing pipeline was rebuilt around what is
  actually visible. On a 96 megapixel document:

  | | before | now |
  |---|---|---|
  | opacity or colour-match slider | 250–900 ms per step | under 10 ms |
  | pan and zoom | stuttering | steady |
  | grow the selection by 16 px | 3.9 s frozen | 0.3 s |
  | magic wand, paint bucket | 1.5–2 s frozen | 0.3 s |
  | saving a layered PSD | 4.1 s frozen | 0.1 s |

  Long jobs now run beside the window instead of stopping it, so the interface keeps
  answering while they finish.

- **Fixed: images larger than 64 MB could not be loaded.** Nothing happened and the reason
  only appeared in the status line. Large files took a route that needed a reachable
  ComfyUI; they are stored locally now like every other image, so loading works with no
  server at all. This also fixes rendering with very large layers.
- **Prompt upsampling with your own API keys.** GPT-5.6 Luna and Terra, Gemini 3.8 Flash and
  3.5 Flash Lite, Claude Opus 5 and Haiku 4.5 appear in the upsample list once a key for
  that provider is stored, next to the ComfyUI nodes. "Select by text" can use them too.
- **Setting presets for local recipes.** Save a model, text encoder and VAE combination
  under a name and pick it again from the Settings section.
- The local / api switch now also switches the recipe list, instead of leaving the previous
  recipe selected in the wrong mode.
- Removed the models the providers retired (gemini-2.5-flash-image, gpt-image-1.5).

## 0.1.1 — 2026-09-09

- **Fixed: filters on very large images showed a stretched corner.** Chromium caps a
  graphics buffer at about 33 megapixels, so a film look on a 10864 × 6062 image rendered
  one corner blown up to full size. Filters render in tiles above that cap now; only the
  16384 pixel limit on a single side remains.
- **Two more API providers**: WaveSpeedAI and Comfy Cloud, each as a variant of the existing
  model recipes.
- Fixed: the provider list in Settings kept showing "(no key)" after a key was saved or
  cleared, until the dialog was reopened.

## 0.1.0 — 2026-09-09

The first public release, under the GPL-3.0.

- A standalone editor for AI inpainting: layers, selection by text, retouch tools,
  filter layers, colour match per layer, text layers, PSD and ORA export.
- Renders through your own ComfyUI, locally or remote, or through an API provider.
- Background removal and object selection run in the app through ONNX (SAM2, BiRefNet,
  RMBG), on the graphics card where possible.
- JavaScript plugins on the command core, with a film pack of eleven looks built in.
- Speaks MCP, so an agent can drive the editor.
- Updates itself from GitHub Releases.

Windows only for now, and the installer is not signed yet, so SmartScreen will warn on the
first start (More info, then Run anyway).
