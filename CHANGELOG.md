# Changelog

What changed in each release, for the people who use Scumble. The release on GitHub carries
the section for its version; `docs/` and the commit history hold the technical detail.

## Unreleased

- **Scumble asks in its own dialogs.** The questions that came in the system's message boxes or the browser's plain box
  now open inside the window, in the colours of the skin in use: Save / Don't Save when a tab closes, a file changed on
  disk or made by a newer Scumble, Save with or without the history, quitting while the last changes are still being
  saved, removing a recipe, a helper model or unused files, closing or restarting while a document works, clearing
  the result history. Enter answers the highlighted button, Escape cancels, the arrow keys move between the buttons;
  a question that deletes something has Cancel highlighted. A skin can recolour them but cannot hide them or change
  the order of their buttons. When the window is too busy to answer at once (a second close while it saves), the system's
  box asks instead. The file pickers and the crash message stay the system's own. Plugins get `ui.ask()` for the
  same dialog.

## 0.1.35 — 2026-09-30

- **Select several layers.** Ctrl+click a layer row to add it to the selection or take it out, Shift+click to select
  the rows in between. With the transform tool the selected layers move together, scale together by the handles of the
  box around them and nudge together with the arrow keys; Ctrl+E merges them into one layer at the place of the
  topmost; Delete removes them; the eye and the lock of a selected row switch all of them. Moving, scaling, nudging, merging and
  deleting are one undo step each; the eye and the lock take none, as always. Locked and filter layers stay where they
  are when the others move, Ctrl+E refuses while one of them is selected, Delete keeps the locked ones, and rotate,
  distort and warp still take one layer at a time. Agents select several with
  `set_active_layer` `layers`, and `list_layers` says which are selected.
- **Align and distribute layers.** The transform tool's bar lines up the selected layers on their left, centre, right,
  top, middle or bottom edge, and spaces them with equal gaps across or down, within the box around them or within the
  canvas (one layer aligns to the canvas). They go by each layer's box, not by its painted pixels. Each click is one undo
  step; locked and filter layers stay put. Agents do the same with `align_layers`.
- **Show only one layer, and back.** Alt+click on a layer's eye showed only that layer before; now it also works for
  several selected layers, a right click on a row offers it as *Show only this layer* beside *Show all layers*, merge
  and delete, and moving the solo from one layer to another keeps what was visible before the first one, so the way
  back always ends where you started (it brought back the first solo before). Solo leaves reference layers alone: a
  hidden reference is not sent, and solo hid them before.
- **Clip a layer to the layer below.** Alt+click the line between two rows, press Ctrl+Alt+G or pick *Clip to layer
  below* in a row's right-click menu, and the upper layer shows only where the layer under it has pixels: its own
  pixels, its mask and its opacity decide how much. Several layers in a row can clip to the same layer; a filter layer
  clipped this way filters only what lies under that layer's pixels. The row gets a small arrow and the layer it clips
  to an underline. A hidden base hides its clipped layers too; over a filter layer, or as the bottom layer, a clip has no
  effect (the arrow is dimmed); a fill layer counts as a filter layer here. The same again releases it; each switch is one undo step. Merging a clipped layer into
  the layer it clips to bakes the clip in. The clip is saved with the document and kept in PSD files both ways (a
  layer clipped to a group or to a layer Scumble leaves out opens unclipped, and says so); ORA has no clipping. Agents
  switch it with `set_layer` `clip`, and `list_layers` says what each clipped layer clips to.
- **Groups.** Ctrl+G (or *Group* in a row's right-click menu) puts the selected layers into a group, a folder in
  the layer list with its own row: fold it open or shut, hide every layer in it with its eye (their own eyes stay as
  they were), lock them all with its lock, rename it with a double click. A click on the group's row selects its layers,
  so they move and scale together. Drag a layer onto a row to put it next to that row in the same group; drag it onto
  the lower half of a group's row to put it into the group at its top; groups drag the same way, and groups go inside
  groups. Ctrl+] and Ctrl+[ step a layer past the next one, into a group next to it or out of its own. Ungroup leaves
  the layers where they are (those of a hidden or locked group stay hidden or locked); the group's trash deletes it with its layers. Each change of the list is one undo step, the
  eye, lock and fold of a group take none, as a layer's do. A group has no opacity or blend mode of its own: the layers
  in it are drawn as if it were not there. A clip stays inside its group. Groups are saved with the document and kept
  in PSD files both ways (a group's opacity goes into its layers when a PSD opens, and says so); ORA gets the layers
  without the groups, those of a hidden group hidden. Agents use `group_layers`, `ungroup_layers` and `set_group`, and
  `list_layers` lists the groups and says which group each layer is in.
- **Fill layers.** The new button beside the filter button in the layer list adds a layer of one colour, which starts in
  the paint colour; its row switches it to a gradient, from that colour to transparent to start with: linear along an angle, reflected from the centre both ways, or
  radial from the centre out, from one colour to another, each end with its own opacity, with a scale and a
  centre set in per cent. The row's picker and sliders change it at any time, and each change is one undo step. A fill layer covers
  what lies below it, and its blend mode, opacity and mask let the picture through: a gradient to transparent in
  multiply darkens one side and leaves the other as it is. It stays sharp at any size and is saved with the document.
  PSD and ORA files get it as a layer of pixels (PSD with its mask, ORA with the mask applied). Agents add one with
  `add_filter` of type `fill` or `gradient`, and `filter_types` marks the fill types.

## 0.1.34 — 2026-09-29

- **Name a reference image in the prompt.** The reference list, the layer panel and the canvas now label every shown
  reference layer img1, img2 and so on from the top of the list (they said "ref 1" before). Write `@img1` in the prompt
  and the request names that picture the way the chosen model counts its pictures: "image 3" when the crop and the
  Original go first, say, and on a local recipe the name its workflow reads (below). The status line says what each
  token went out as ("Named in the prompt: `@img2` → image 3."). A token stays with its picture: a new reference now
  goes below the others and takes the next number, so nothing is renumbered, and when references are moved, hidden,
  shown, merged or deleted the tokens in the prompt are rewritten so each still names the same picture (hiding one
  renumbers the others, and their tokens follow). A token whose reference is hidden or deleted waits, and Generate stops
  and says why until you show the layer again, undo the delete or take the token out. The negative prompt takes tokens
  too, as plain text. A run now reads the prompt and the references at the moment you click, so an edit made while it
  starts no longer changes what goes out. An upscale sends no reference images, so there a token goes out as its layer's
  name (the Upscale dialog fills its prompt that way), and Select by text, when it asks the language model what the
  prompt is about, reads a token as "the reference image".
- **Reference chips in the prompt field.** Each token shows as a chip: a small round picture of the reference and its
  label. A chip whose reference is hidden is struck through and shows the layer's name; one whose reference was deleted,
  or whose number no reference holds, is struck through in red. A chip counts as one character: the caret steps over it,
  and Backspace or Delete takes it whole. A token becomes a chip once you type the space after it (so `@img12` can be
  typed without a chip for `@img1` on the way), a word typed right against a chip gets a space between the two, and a
  click on a chip puts the caret beside it. The prompt field keeps its own undo: Ctrl+Z and Ctrl+Y there take back
  typing, a paste, Upsample, Revert or a prompt an agent set, never an edit of the picture. Its lines are a little
  taller, to fit the chips.
- **The @ list, the reference bar and the card.** Type @ at the start of a word and a list of the shown references opens
  under the caret, each with its picture, label, layer name and what the model gets it as; what you type after the @
  narrows it. The arrow keys move in it, Enter or Tab puts the reference in, Escape closes it (a second Escape leaves
  the field). "+ Add reference" at the end of the list adds pictures as new reference layers and names them where the @
  was, and a picture pasted into the prompt or dropped on it does the same (text still pastes as text). Above the field
  a bar shows every reference as a chip (a hidden one dimmed), a + that adds pictures, and how many references the
  recipe takes besides the crop and the Original ("2 of 3 for this recipe"); a click on a chip there names it at the
  caret. A chip past what the recipe takes gets a yellow edge, and when the recipe sends no reference images at all (an
  upscale, say) every chip in the prompt is struck through and the bar dims its chips and says the recipe sends none.
  Rest the mouse on a chip for a moment and a card shows a larger picture, the layer's name and what the token goes out
  as ("img2 · sent as image 3"), or why it does not go. The small arrow on a chip swaps it for another reference, shows
  a hidden reference again or takes the token out; a chip can be dragged to another place in the text, and a selection
  dragged inside the field moves there (hold Ctrl to copy it).
- **Generate new keeps the reference layers and sends them along.** The new picture replaces the old one and every other
  layer, but the reference layers stay, and the shown ones go to the models that take reference images for a new image:
  FLUX.2, GPT Image, Nano Banana, Seedream and HY Image 3.5 on every provider that runs them here, Qwen Image Edit on
  ToAPIs, WaveSpeed, Comfy Router and Oxen.ai (not on fal or Replicate), Qwen Image 2.1 on Oxen.ai, and Grok Imagine on
  fal, OpenRouter and Oxen.ai. There is no crop before them, so `@img1` goes out as the model's first picture
  ("image 1", `<image1>` on Qwen Image 2.1); shown references the prompt does not name go along too, and a hidden one
  stays in the tab without being sent. A model that makes pictures from the prompt alone (Ideogram, Recraft, Reve and
  the others) sends none and keeps them in the tab, and stops the run when the prompt names one. Through a provider the
  status line says what each token went out as and how many other layers were replaced. The dialog's prompt field works
  like the Generate tab's, with chips, the @ list and the bar, and the card on each chip says what its reference goes
  out as for the model and provider picked in the dialog; its Upsample keeps the tokens (next item) and has its own
  Revert. In an empty tab, a reference added through the prompt field (its +, the @ list, a picture pasted or dropped
  on it) first gets a white 1024 × 1024 canvas for Generate new to replace. On a local recipe the references follow the
  white canvas the recipe renders on, so there `@img1` is the second picture (the third when Original is on with a
  fill), and a local Generate new checks the tokens and the connection to ComfyUI before it replaces anything.
- **Upsampling keeps the tokens and sees the reference images.** The language model is told which reference each token
  names and to leave the tokens as they are. A token for a hidden or deleted reference, or a number no reference holds,
  stops the upsampling with the reason. When a rewrite drops a token, adds one or names a picture by number instead
  ("image 3"), the status line says so ("Check the tokens: the rewrite dropped `@img2`."), and Revert brings your prompt
  back; a reference moved, hidden or merged while the model answers keeps its tokens in the answer. With an API model or
  the local endpoint, the language model also sees the reference images the prompt names (up to six, at most 512 px
  each), so the rewrite knows what each token is; they go to that model's provider along with the crop. The switch that
  keeps them back is in Settings › Prompt templates (on by default); the ComfyUI helper upsampler gets the names only.
  On the local endpoint, ToAPIs, OpenRouter and Oxen.ai a model that turns the pictures down is asked again with the
  crop alone, and the status line says "crop only". Prompt templates get a `{references}` placeholder, which the five
  shipped ones use; a template of your own without it gets the names added at the end.
- **Local ComfyUI recipes name the pictures too.** On a local recipe a token goes out as the name that recipe's model
  reads for its picture: `<image3>` on Qwen Image Edit 2.1, "image 3" on FLUX.2 Klein; the prompt field keeps the token.
  Klein now reads up to 4 pictures and Qwen Image Edit 2.1 up to 10, the crop and the Original included. Klein used to
  read the crop and one more picture only, so with Original on no reference reached it at all, and both repeated the
  last picture into the slots the batch left empty; they no longer do, so the same seed gives another result than in
  0.1.33. A reference past what the recipe reads is left out with a note ("img3 is not sent"), and a token that names
  one stops the run and says why. The status line says what each token went out as, and the app's log keeps the prompt
  as it was sent whenever it named a reference. The References line at the foot of the Crop panel reads "img1 →
  `<image3>`", and its batch count leaves the Original out on a refine pass, as the node does. A workflow of your own is
  read the same way; where Scumble cannot tell how its graph numbers the pictures, it writes "image 3" by their place in
  the batch and says the wording is guessed. Neither widened workflow has run on a real ComfyUI yet.
- **Every API route says what it sends.** Where a route writes a sentence of its own around your prompt, it now numbers
  the pictures the way the tokens do ("Edit image 1 and keep its size and framing. … Images 3 and 4 are reference
  images."), with a sentence for the Original ("Image 2 is image 1 before the selected area was filled."). Nano Banana
  on Google Gemini and on Comfy Router's Google route gets a label ("Image 1:") before each picture when more than one
  goes. No reference is left out without a word any more: a route sends every picture; or it refuses before anything is
  sent when there are more than the model takes, with the count and what to do ("… takes at most 8 pictures; this run
  has 9 (the crop, the Original, 7 reference layers): hide reference layers or turn Original off."); or, where the
  endpoint takes no reference at all (the FLUX.1 Fill and other fill endpoints, Replicate's Qwen Image Edit, Nano
  Banana Pro on Comfy Cloud), it sends none and says so in the status line, and a prompt that names a reference there
  stops the run. Ideogram Inpaint on Magnific sends the reference layers as style references, which have no number:
  they go along, but a prompt that names one there stops the run. The limits follow each provider's documentation: on
  Black Forest Labs FLUX.2 [klein] takes 4 pictures and [pro], [flex] and [max] 8 (it kept 7 references and dropped the
  rest silently before), FLUX.2 on WaveSpeed 3 (a run with the Original and two references is refused now), Grok
  Imagine on fal 5, Seedream on fal 10, Nano Banana 14 and GPT Image 16 on most providers. FLUX.1 Fill on Comfy Router
  runs again while a reference layer is shown (it refused) and leaves the references out, as its note says, and Comfy
  Cloud uploads only the pictures its node reads. None of this has run against a live API yet.
- **The reference list keeps the order you give it.** Up and down in the reference list step past the next reference;
  with an image layer between two references a click used to add an undo step and change nothing. Ctrl+] and Ctrl+[ on a
  reference do the same. Changing a layer's role (the layer panel's selects, the image button in the reference list,
  "Turn into a normal image layer") is an undo step of its own ("Layer role"), and a layer made a reference goes below
  the other references and takes the next number, as a new or a duplicated reference does ("added as `@img3`").
- **Generate new on Replicate keeps the aspect you ask for.** FLUX.2, Nano Banana and Seedream on Replicate asked for
  the input image's aspect, with no input image to match; now the chosen aspect goes, and for a free size the model's
  preset closest to it.
- **Language models get what their row says.** A model added under Settings › Language models with "Can see the
  picture" unticked now really gets no picture, the crop included (the local endpoint's model too). The local endpoint
  asks again without the picture only when the failure is about the request or the images (400, 413, 415, 422, or a
  message that names images): a wrong key, an empty balance, a rate limit or a missing model costs one request.
  ToAPIs, OpenRouter and Oxen.ai step down to the crop alone when the server finds the reference pictures too large
  (413).
- **For agents and the assistant:** `list_layers` and `status` give each reference layer its `label` (`img1`, null while
  it is hidden), and `status` its `sent_as` for the selected recipe; `set_prompt` and `generate_new` take `refs` to pin
  a token to a layer; `generate` returns `prompt_sent` and `notes`, and a run it cannot start fails at once instead of
  after a wait; `upsample_prompt` returns `check`; `generate_new` returns `references`, `kept` and `dropped` on an API
  recipe; `list_recipes` says with `textRefs` whether Generate new sends references; `add_image_layer` adds a reference
  to an empty tab on a white canvas. The assistant sees which layers are references and the token of each.

## 0.1.33 — 2026-09-29

- **Erasing is fast again.** Since 0.1.32 the eraser, the brush, clone and heal got four to seven times slower with a
  large brush (700 px and up) on a large picture whenever the pen, or a fast mouse, sent more points than the screen
  showed frames, which a pen does all the time: each of those points was painted as a little stroke of its own, and
  every slow frame made the next one slower still. It was felt most inside a selection. A move is one piece of the
  stroke again: erasing and painting cost what they did in 0.1.31, clone and heal about a fifth of what they cost in
  0.1.32. The stroke still follows every point the pen sends, and the pressure still sizes the brush point by point.
- **A soft brush under a pen is as even as under the mouse.** 0.1.32 put a dab down twice at every point the pen sent,
  and where the pressure changed within a frame it spaced the large dabs as the smallest, so a soft edge came out a
  little harder with a pen than with the mouse.
- **Follow stroke** turns an imported tip with the stroke again when the pen moves slowly; in 0.1.32 it could keep the
  angle of the stroke before.

## 0.1.32 — 2026-09-28

- **Remove.** A new tool (Shift+J, beside heal) takes things out of the picture: brush over an object, a person, a
  wire or a blemish and let go, and LaMa fills the stroke from what surrounds it. LaMa runs inside Scumble on the
  processor: no prompt, no key, no ComfyUI. Download it once (198 MB) in Settings › Helpers; the tool loads it when you
  pick it (about 10 s the first time), and then a stroke takes one to two seconds. The fill goes into the active layer
  as one undo step, on the base into a new layer. A small spot is filled at full resolution, a large stroke comes back
  softer than the picture around it.
- **Patch.** A new tool (Shift+J again, after Remove) repairs a whole area: lasso the spot, drag the selection to where
  the picture is right and let go. That texture is laid into the spot and takes on the colour and light around it,
  without a rim; while you drag, the spot shows what it would take. *Destination* copies the selection to where you let
  go instead, and *Blend* below 100 % keeps more of the copied texture's own colour (at 0 % it goes in as it is). One
  undo step, in the active layer (on the base in a new layer); the selection stays, so you can drag again (Ctrl+Z first
  for a clean second try).
- **Content-aware move.** A new tool (Shift+J a third time) moves something within the picture: lasso it with a little
  of its surroundings, drag it and let go. It lands there as it was, its edge blending into the new place, and LaMa
  fills where it was. *Extend* places a copy and leaves the original (no model needed); *Blend: all* lets the whole
  piece take on the new place's light. One undo step, in the active layer (on the base in a new layer). The selection
  stays where the object was, so a second drag moves what now fills that place, not the object.
- **Liquify.** A new tool (Shift+W, or Ctrl+Shift+X) bends the picture with the brush: push drags it along, grow swells
  and shrink pinches what is under the brush, swirl turns it, restore brings it back (Alt swaps grow and shrink and the
  swirl's direction). You see the result while you drag, and every stroke is one undo step. As long as Liquify stays the
  tool on the same layer, every stroke is taken from the layer as it was when you started, so the picture does not
  soften stroke by stroke, and *Restore all* gets that back exactly; after another tool (Space to pan is fine) or
  another layer, restore goes back only to that point, while Ctrl+Z still goes further. A selection limits it, and so
  does a freeze you paint (the modes *freeze* and *thaw*, shown in red; a lower Strength freezes only partly). The
  freeze stays with its layer while the document is open, but Ctrl+Z does not take it back and it is not saved. On the
  base Liquify works on a copy, the layer *Liquify*.
- **LaMa remove (in-app).** The same model as a recipe: select what should go, pick *LaMa remove (in-app)* and press
  Generate, offline.
- **The healing brush blends.** Heal (J) now lays the source's texture into the colour and light around the stroke,
  right up to its edge, so the repair has no rim: a gradient-domain ("Poisson") blend when you let go, the way the
  healing brush works in Photoshop. While you paint you still see the quick version. A spot heals at once; a large
  stroke takes a moment, and the brush and the shortcuts wait for it (Ctrl+Z pressed meanwhile takes it back once it has
  landed). With a selection the blend stops at the selection's edge and meets the picture there too. Clone and heal no
  longer paint while quick mask is on or a mask is being edited (neither do the smudge, blur, sharpen, dodge, burn and
  sponge); the status line says why.
- **Straighten the picture.** The Canvas tool (C) turns the whole picture by up to 45° either way (the quarter turns in
  the Image menu do the rest) and crops it in one step: drag outside the frame to turn it, set the angle in the bar
  above the canvas, or draw a line along a horizon or a wall with Ctrl held (or the Straighten button) and the picture
  turns until that line is level or plumb. The frame stays inside the turned picture, the largest one of the chosen
  aspect. Every layer, mask and the selection are turned with it, text stays editable, and one Ctrl+Z takes it all back.
  Agents get `straighten_canvas`.
- **The canvas frame waits for you.** Dragging the frame no longer crops or extends when you let go: move and
  resize it as often as you like, then press Enter, click Apply or double-click inside it; Esc resets it. Aspect
  presets (original, 1:1, 4:3, 3:2, 16:9, 5:4 or your own; X turns it on its side) fit the largest frame into the
  picture, and the frame can show thirds, the golden section, a grid or diagonals to compose by.
- **Text turns by any angle and stays text.** Turn a text layer with the transform tool (T) or its new Angle field and
  it stays editable: change the words, the font or the size and it keeps its angle, drawn sharp at every edit. (A text
  turned in an older version has no angle stored and still comes back upright at its first edit: type its angle once
  into the Angle field and it keeps it from then on.) Distort and warp still turn a text into pixels, now with a note
  and one undo step that brings the text back. Agents turn text with an `angle` on `add_text` and `set_text`, and
  `list_layers` reports it.
- **Guides, saved selections and past results follow crop, extend and resize.** Cropping used to leave the guides, a
  saved selection and a result's place in the history where they were, so they landed off by what was cut away; now they
  move with the picture (and scale with a resize), like they already turned with it. Film look control points and 3D
  objects follow too. A pixel size typed into the Export panel's Size row is cleared by a crop, extend, resize or
  straighten, so the export follows the new shape instead of stretching it to the old one. While a render, a text
  selection, a cutout or a save is still running, crop, extend, resize, the frame's Apply and upscaling the whole
  picture wait for it (the result lands where it was made for): the status line says so, and the frame stays for you to
  apply afterwards.
- **PNG exports carry the prompt and the recipe again.** *Prompt and recipe in the PNG* in the Export panel is on unless
  you untick it (it was off since 0.1.30). **This update turns it on even if you had unticked it** in 0.1.30 or 0.1.31
  (those versions could not tell your choice from their default): untick it once more if your PNGs should carry nothing;
  from now on it stays as you set it. JPEG, WebP, TIFF, PSD and ORA never carry them. What the recipe names like a key,
  a token, a secret or a password stays out of the file: a workflow you imported with an API key typed into one of its
  nodes no longer hands that key to whoever gets the picture.
- **The Opacity slider is back for the brushes.** The paint brush, the eraser, clone, heal, the bucket and the
  gradient showed no Opacity slider since the shape tool came; it is in their bar again.
- **`[` and `]` size the brush on a German keyboard.** Typed with AltGr, they moved the active layer up or down
  instead; AltGr+ß (`\`) now peeks at the base as it should.
- **Text keeps the font file it was set in.** When a document you opened brought a font whose name was already taken
  by another file of yours (it is stored as "MyFont (1).ttf" then), its text could be drawn from your file instead
  on the next edit. Each text now uses the file it names, and two fonts of the same name can be used side by side.
- **Rotating a masked layer says what happens to the mask.** The transform tool's rotate, distort and warp bake a
  layer's mask into its pixels (or drop a switched-off one); the status line now says so, and Ctrl+Z still brings the
  mask back. (A text layer, and any layer turned by the 90° buttons, keeps its mask as a mask.)
- **Out of memory says so.** A window holds about 15.5 GB of pixels (18 full layers at 15,000 × 10,000); one more used
  to end in an error in the log and a stroke half written. Now the status line says memory ran out and what gives it
  back (closing a document, or fewer Undo history steps in Settings › Rendering: a deleted or merged layer is kept by
  its undo step), and a stroke that hit it can be undone as usual.
- **One undo step for a layer the assistant duplicates.** It used to leave a second, empty step in the Undo history, so
  the second Ctrl+Z seemed to do nothing.
- **Smudge, clone and heal stay fast on large pictures.** They read the whole picture before: clone and heal flattened
  it at every stroke (up to 1.7 s at 15,000 × 10,000 before the brush moved) and the smudge read the whole layer at
  every step (up to 8 s a move). Now each reads only what is under the brush: a few milliseconds a move at any picture
  size (a few tens near the largest brush), and a gigabyte less memory. Heal matches the colour more exactly. On the
  base the smudge no longer copies the whole base into a layer first: it paints into a new layer from the picture.
- **Frequency separation and the linear light blend mode.** *Image › Frequency Separation…* splits the picture, or the
  selection's box (up to 16 megapixels at a time: on a larger picture select the face first), into a low-frequency layer
  (colour and tone) and a high-frequency layer (texture) that give the picture back exactly, so you can even out skin
  tone on one and heal texture on the other. The high layer uses the new **linear light** blend mode, which every layer
  can use now; PSD files keep it both ways (an ORA only for Scumble). A document with a linear-light layer needs 0.1.32
  or newer to open; every other document still opens in 0.1.31, where a text turned by a free angle comes back upright
  at its next edit. `set_layer` refuses a mistyped blend mode instead of drawing it as normal, and agents get
  `frequency_separation`.
- **Dodge, burn and sponge.** A new brush (Shift+O, beside smudge, clone and heal) lightens (dodge) or darkens (burn)
  the shadows, midtones or highlights by the Exposure you set, with GIMP's own curves; *Protect tones* moves the colour
  channels together so colours keep their hue (a strong highlights dodge can still blow out what is already bright).
  Hold Alt while you press to burn with the dodge and the other way round. The sponge saturates (with *Vibrance*, dull
  colours gain most and nothing clips) or desaturates. A stroke does not pile up over itself; a new stroke goes further.
  It works from the layer, the layers below or the whole picture, and on the base it paints into a new layer. *Image ›
  New Dodge & Burn Layer* adds an empty soft-light layer to paint white and black on (the same picture as the classic
  50 % grey layer, without its memory); the *(50 % Grey)* entry makes the grey one. Agents get `dodge_burn_layer`.
- **A picker for the brush tips.** Click the tip's thumbnail in the brush bar (or the word *Tip*) and every tip
  opens in a list, each with a stroke drawn with it, grouped by the file it came from, the tips you used last on top
  and a search over the names and the file names, for a pack of hundreds. A click picks a tip and leaves the list
  open, so you can try a few; a double click or Enter picks and closes it, and so do a click beside it, Esc and the
  thumbnail. *Import…* is in it too.
- **Brushes up to 1,000 px.** The largest brush was 400 px; now it is 1,000. A brush that large does more work at every
  move: on a 15,000 px picture a 1,000 px clone takes about 20 ms a move and the smudge 30 to 40 ms, so the smudge
  trails the cursor a little. The Size slider runs logarithmically, so the small sizes keep their room; `[` and `]` and
  `set_brush` go up to 1,000 as well.
- **Blur and sharpen brushes.** The smudge tool has a **Mode**: smudge, blur (softens what the brush passes over) or
  sharpen (crisps it). Strength is how far each dab moves the picture towards that; the dabs overlap, so at the default
  one pass goes nearly all the way (set it low for a gentle touch). Going over a place again within one stroke does not
  go further, a new stroke adds to it, and a click works on a spot. Sample picks the layer or the whole picture, as for
  the smudge.
- **Flow, a pressure curve and a stabiliser for the brushes.** **Flow** (the paint brush and the eraser) sets how much
  paint each dab lays down: below 100 % a stroke builds up where it passes again, while Opacity still caps the whole
  stroke. **Pressure** chooses how a pen's pressure sizes the brush (linear, soft for a light hand, hard), and
  **Stabiliser** lets the brush follow the cursor on a string, so a trembling hand draws a calm line; letting go
  finishes the line to the cursor. Fast pen strokes are smoother too: every pen sample between two screen frames is
  painted now, not only the last one. Agents set the flow with `set_brush`.
- **Clone and heal turn, scale and mirror their source, and show it under the brush.** New fields in their bar:
  **Angle**, **Scale** and **Flip H / V** set how the source lands (a window reflected the other way, a pattern at
  twice its size), and **Overlay** shows what the brush would copy, half transparent inside the brush circle, while
  the source is on screen. The source's crosshair follows the brush when Aligned is on. Imported brush tips shape
  clone and heal too.
- **A smudge that carries paint.** The smudge brush now holds the paint it picks up and lays it down as it goes:
  **Strength** is how much goes down, the new **Length** how far it goes on (0 drags what the last step left
  behind; towards 100 the colour goes on to the end of the stroke), **Finger** starts every stroke with the paint
  colour on the brush, and **Sample** takes the active layer, the layers up to it (below) or the whole visible
  picture. Like a real smudge it drags transparency too: a stroke that starts beyond a layer's edge thins what it
  crosses (tick alpha lock to keep the layer's alpha). It keeps the colour exact over long drags, respects the
  selection, works with imported brush tips, and pen pressure sets its size and strength.
- **For plugin authors:** the `geometry` event now fires for crop, extend, resize (an upscale too) and straighten as
  well, not only for turns and mirrors. Every event carries `kind` and `m`, the matrix from old to new image
  coordinates, and `op` only when `kind` is `"turn"`: a handler written for 0.1.31 checks `kind` first
  (`docs/PLUGINS.md`).

## 0.1.31 — 2026-09-27

- **Canvas only: Tab hides everything but the picture.** The tab bar, the editor's bars, the tools, the side panel
  and the rulers go, the window goes full screen and the picture is fitted into it; every tool and key keeps working.
  Tab again or Escape brings it all back, with your zoom, the rulers and the window as they were (while a transform,
  a polygon or a text edit is pending, the first Escape cancels only that). Also in View › Canvas Only. Tab in a text
  field stays a Tab.
- **Undo history.** A new section in the Image tab lists every undo step by name ("Brush stroke", "Rectangle
  selection", "Merge down", "Crop canvas", ...), oldest first, with the time in its tooltip; a click jumps to any
  of them, forward or back, and the steps you undid stay listed below until you edit again. **Snapshots** keep the
  whole document under a name, to come back to later: up to eight per tab, they cost nothing when taken, and
  restoring one is an undo step of its own. How deep the history goes is now a setting (Settings › Rendering: 30
  steps, and 384 MB for the copies brush strokes and selections keep, by default). Agents get `list_history`,
  `take_snapshot`, `restore_snapshot` and `delete_snapshot`, and `undo` / `redo` take a number of steps.
- **Layer masks stay masks in PSD.** A PSD export used to bake every mask into its layer's transparency; now the
  layer's pixels go out whole and the mask as Photoshop's own layer mask, so Photoshop, Affinity, Krita or GIMP can
  go on editing it. Opening a PSD keeps its layer masks as masks too, where they used to be applied and lost. ORA has
  no layer masks and still bakes them.
- **A mask can be switched off** without deleting it: the eye button in the layer's mask row, or Shift+click on the
  word "mask" as in Photoshop. The layer shows whole, the mask stays and follows moves, crops and saves, and
  painting the mask switches it on again. PSD files carry the switch both ways.
- **Mask operations.** The "..." button in a layer's mask row (or a right click on the word "mask") opens
  Reveal all and Hide all (a white or a black mask, added when the layer has none), Reveal selection and Hide
  selection, and Invert mask. Each is one undo step. Agents get `set_mask` with the same operations plus
  enable / disable, apply and remove.
- **The side panel can be wider.** Drag its left edge (between 310 px and 60 % of the window); a double click on the
  edge goes back to the default. Every tab shows the same width, and Scumble keeps it for the next start.
- **Rotate and flip the whole picture.** Image › Rotate 90° Clockwise / Counter-clockwise / 180° and Flip
  Horizontal / Vertical, also in the Canvas section: every layer turns with the picture, with its mask, and so do the
  selection, the guides, saved selections and earlier results; text stays editable and keeps the turn. Nothing is
  resampled, and it is one undo step. A layer flipped or turned on its own now keeps that too when its text is edited.
  Agents get `rotate_canvas` and `flip_canvas`.

## 0.1.30 — 2026-09-27

- **Documents: save your work as a `.scumble` file.** A document file keeps everything the way you left it: every
  layer with its mask, text that stays editable, shapes, filter layers, colour match, the selection and the saved
  selections, guides, the crop, the prompts, the recipe and its settings, 3D objects, and the result history. Open it
  again, on this machine or another, and you carry on where you stopped; fonts you added travel inside it.
  **Ctrl+S saves the document** (the first time it asks where), **Ctrl+Shift+S** is Save As, and the picture export
  that was on Ctrl+S moved to **Ctrl+Shift+E** (File › Export Image). A tab with unsaved changes shows a "*" in its
  name and in the window title; closing it asks Save / Don't Save / Cancel, while a saved one closes without a
  question. **File › Reopen Closed Tab** (Ctrl+Shift+T) brings back the last ten closed tabs, **File › Open Recent**
  lists the last ten documents. Save As on a document with results asks whether the history (and the prompts of
  earlier runs) goes along, for when you pass the file on. A `.scumble` opens by double click (the installer
  registers the file type), by dropping it on the window or from the Open dialog. A save writes a new file and swaps
  it in only when it is complete, so a crash or a full disk during a save leaves the old file as it was. A 15000 ×
  10000 picture with four layers saves in about half a second once its layers are stored. Agents get
  `save_document` and `open_document`, and plugins can keep their own data in the document. Quitting still asks
  nothing: the next start brings every tab back, unsaved ones still marked.
- **Exported PNGs no longer carry your prompt.** Until now every PNG export held the prompt, the negative prompt, the
  seed and the recipe as text inside the file, readable by anyone you sent it to, and for a recipe imported from your
  own ComfyUI workflow every setting of that workflow. Now that happens only when you tick **Prompt and recipe in the
  PNG** in the Export panel (it stays as you set it, for every document); agents pass `metadata` to `export`. JPEG,
  WebP, PSD and ORA never carried any of it.
- **PNG exports are marked as sRGB**, which their colours are, so other programs show them the way Scumble does. JPEG
  and WebP exports already carried an sRGB profile.
- **TIFF opens and saves.** The Open dialog offered TIFF files and then failed on every one. Now they open in 8 and 16
  bits per channel (16 rounded to 8), RGB, grayscale or with a palette, uncompressed or with LZW, ZIP or PackBits
  compression, in strips or tiles, with their transparency; by Open, drop, as a layer (Layers › Import) and for agents
  through `load_image` and `add_image_layer`. A file with several pages opens its first picture; a colour profile, the
  orientation tag and Photoshop's layers inside a TIFF are not applied, and the status line says so. CMYK,
  floating-point, 32-bit and JPEG-compressed TIFFs are refused with a message that says how to save them instead.
  **TIFF is an export format** too (8 bits RGBA, ZIP compression), at any size the Export panel allows, written in
  strips by the worker threads like PNG; agents pass `format: "tiff"` to `export`. Large files are read and written as
  a stream, so a 15,000 pixel TIFF never has to fit into memory as one piece.

## 0.1.29 — 2026-09-26

- **Magnific as a full provider.** Beyond its two upscalers, your Magnific key now runs FLUX.2 [pro] and [flex],
  Seedream 5.0 Pro and Lite, GPT Image 2 and 2.5 (Flare, Sunburst) and Z-Image Turbo, each as the last choice in its
  recipe (no default changed), and new recipes of its own: **Mystic**, Magnific's own model, in Generate new;
  **Seedream 4.5**; and **Ideogram Inpaint**, real mask inpainting, where the model repaints only the selection.
  **Outpainting with Image Expand** (FLUX Pro, Ideogram or Seedream 4.5): extend the canvas, keep the new border
  selected, pick an Outpaint recipe and Generate; the model draws the border around what you keep. Models that only
  render preset shapes get the crop's context widened to the nearest one, so their answer lines up with the picture.
  Every Magnific API call costs credits, whatever your web plan says. Written from Magnific's documentation; none of
  it has run against the live API yet.
- **Oxen.ai as a provider.** One Oxen key runs twenty recipes: GPT Image 2 and 2.5 (Flare, Sunburst) with the
  selection as mask, Nano Banana 2, 2 Lite and Pro, Seedream 5.0 Pro and Lite, FLUX.2 [pro], [flex] and [klein], Qwen
  Image 3.0, Grok Imagine, Krea 2, Ideogram 4 and Z-Image Turbo in Generate new, the three Topaz upscalers, and
  **Qwen Image 2.1**, a new recipe that runs only on Oxen. The same key gives three prompt-upsampling models and three
  assistant models. Oxen.ai comes after Comfy Router in each recipe's provider list (Magnific stays last); no default
  changed. The pictures go to Oxen inline, and Oxen saves every generated image in your Oxen account. Written from
  Oxen's documentation and model list; **nothing has run against the live API yet**.
- **Skins.** Settings › Appearance and View › Skin switch the app's look: the default, **90s** (a late-90s media
  player: bevelled slate panels, green LCD readouts, small type) or **Duck** (warm cream, lavender and orange,
  rounded). A skin is a folder with a `plugin.json` and a `skin.css`, no code, so you can make your own
  (docs/SKINS.md). The assistant's questions, the picture's surround and the selection outline look the same in
  every skin.
- **Closing no longer loses your last strokes.** Edited layers used to be saved 15 seconds after the last change,
  and closing the window or installing an update did not wait for that: the last strokes, or a layer made in those
  seconds, could be gone at the next start. Now closing waits until everything is saved (about a second, a few on a
  very large picture; closing again while it saves asks whether to wait), an update's installer starts only after
  it, and View › Reload saves first too. If Scumble's window crashes, it comes back by itself with your documents.
  If it crashes again right away, it starts empty and keeps them aside. **Settings › Local files › Earlier states**
  opens the documents of the last two sessions, or those kept aside, as new tabs.

## 0.1.28 — 2026-09-23

- **Comfy Router as a provider.** Comfy's direct model API runs sixteen of the recipes on the Comfy key you may
  already have in the Comfy Cloud row, billed in Comfy credits and **without a paid Comfy Cloud plan**: GPT Image 2
  and 2.5 (Flare, Sunburst) with the selection as mask, Nano Banana 2, 2 Lite and Pro, FLUX.2 [pro] and [max],
  FLUX.1 Fill, Seedream 5.0 Lite and Pro, Qwen Image 3.0, Magnific Precision as an upscaler, and Grok Imagine 2.0,
  Ideogram 4 and Krea 2 in Generate new. It is the last choice in each recipe's provider list; no default changed.
  A run goes into Comfy's queue and is collected when it is done, and a request that has to be sent again (a lost
  answer, a busy moment) is never billed twice. Written from Comfy's documentation and each model's published
  schema. GPT Image 2 and Nano Banana 2 ran against the live Router before the release; the rest has not yet.

- **HY Image 3.5 Preview**, Tencent's new image model, as a recipe of its own: edits with up to five pictures (the
  crop, Original and reference layers; name them @Image1, @Image2 in the prompt) and Generate new. It runs through
  Comfy's Partner API, the route ComfyUI's own HY Image nodes use, on the same Comfy key and credits (about $0.03 an
  image). That route is not a published API, so a change on Comfy's side can break it until Scumble follows.

## 0.1.27 — 2026-09-23

- **Help, in the app (F1).** The manual opens in a column beside the picture: every chapter, searchable,
  offline, and the same text as on the website, now kept next to the code it describes. Above it sits a
  chat that answers questions about Scumble from that manual and from nothing else, names the chapter
  its answer comes from, and says so when the manual does not cover something instead of guessing. It
  runs on any model you have a key for, small text-only ones included, and it cannot change anything in
  the app (that is the assistant's job). What goes to the provider is your question and the manual, no
  picture and no file. *Help › Editor guide*, which opened the ComfyUI node's README, is gone.

- **Scumble has a logo.** A small creature made of paint, with a chalk brush stroke behind it that shows through
  its body: that is what a scumble is, a thin semi-opaque layer over a dry one. It replaces the first icon from the
  project's opening week. The window, the taskbar, the installer and the shortcut carry it. At 16 and 24 pixels the
  icon carries a simplified drawing of its own (no mouth, larger eyes), as an icon file is meant to.

- **The Upscale dialog has a prompt field** for the upscalers that take one (Clarity, Magnific Creative). They always
  followed the prompt of the Generate tab, but the dialog did not show it, so it looked as if no prompt could go
  along. The field starts with the tab's prompt; what you type there goes to the upscaler and leaves the tab's
  prompt as it was. Agents pass it as `prompt` to the `upscale` command, and `list_recipes` says which upscalers
  use one.

- **A smaller installer again: 128 MB** (0.1.26: 134 MB; 410 MB installed instead of 421). 0.1.26 packed the whole
  project folder by mistake: the development docs, the tests, the build scripts and the Rust sources went into every
  install, where nothing ever read them. Nothing in them was private, and the app did not change with them.

- **OpenRouter's notes say what has really run.** GPT Image 2.5 Flare and Sunburst have run through OpenRouter since
  2026-09-21, and their recipes no longer call the route untested; the other models behind OpenRouter say that the
  route works but that model has not been tried yet. Found on the way: OpenAI's safety system can refuse a crop whose
  context takes in bare skin even when the selection itself is harmless; a tighter *Context* in the Crop panel helps
  (docs/RECIPES.md, "OpenRouter").

## 0.1.26 — 2026-09-22

- **A smaller Windows installer:** 134 MB instead of 188 MB (421 MB installed instead of 676 MB). It carried the
  helper models' runtime for macOS, Linux and Windows on ARM, which a Windows x64 install never loads, and Chromium's
  interface texts in 55 languages; it keeps English and German now (the menus, the dialogs and the editor are
  English either way).
- **A Linux build:** an AppImage and a .deb beside the Windows installer on every release, and the AppImage updates
  itself like the Windows app. **It has not been tried by the author on Linux** (reports welcome). The helper models
  (SAM2, background removal) run on the CPU there. *Settings › API providers* warns when the system offers no
  keyring (`basic_text`): the keys are then only obfuscated, not encrypted. *Help › Copy MCP registration* names the
  AppImage file itself, not a path inside it that changes with every start.

## 0.1.25 — 2026-09-22

- **PSD and ORA files open with their layers.** *Open*, drag and drop and the `load_image` command read a
  Photoshop PSD or an OpenRaster ORA as layers: names, positions, opacity, visibility and blend modes. The bottom
  layer becomes the picture when it covers it (Photoshop's *Background*, or a file Scumble saved); otherwise the
  picture is transparent and every layer stays a layer. Layer masks are applied to the layer's transparency, groups
  are flattened into their layers (their visibility and opacity carried along). What Scumble has no place for is
  named in the status line: adjustment and fill layers are left out, clipping masks and blend modes Scumble lacks
  are not kept. RGB and grayscale, 8 and 16 bit; PSB, CMYK and 32-bit files are refused with a reason. Dropping a
  PSD on an open picture adds its layers to it.
- **PSD export keeps layer names with umlauts and other non-ASCII letters.** They were written as underscores
  ("G_rtel"); Photoshop and Scumble now read the full name.
- **Upscale on your own ComfyUI.** A new recipe, *Upscale model (ComfyUI)*, runs any upscale model from your
  server's `models/upscale_models` folder (ESRGAN, UltraSharp, DAT, ...); pick the model under *Settings* as for
  any recipe. It works on **the selection**: the box goes out at its own size, without a fill or the reference
  layers, and the model's larger answer is fitted back into it, a sharper detail pass at the document's
  resolution. The whole picture is not offered on this route (the *Upscale* dialog greys it out); an API
  upscaler still does that. *Generate* with this recipe selected does the same. It has not run on a real
  ComfyUI yet.
- **The upscalers have run for real now:** Topaz Precision through fal (a selection and a whole 2 MP picture, about
  25 s each, and once 4 times larger to 33 MP in 34 s), Magnific Precision and Magnific Creative through Magnific (a selection each). Magnific Precision is
  slow, five minutes for a small box; the status line now says so while it runs, as it does for Topaz.
- The assistant's question before an upscale of the selection now says that it costs money **or queues on your
  ComfyUI**.

## 0.1.24 — 2026-09-22

- **Upscale.** A new *Upscale* button next to *Generate new* opens a small dialog: pick the model, then either
  **the selection** or **the whole picture**, and the factor.
  - *The selection* goes to the upscaler at its own size, and the sharper answer comes back into the selection at
    the document's resolution, as a new layer: a detail pass, nothing gets bigger. *Generate* does the same while an
    upscale model is the selected recipe.
  - *The whole picture* sends the base image, and the answer becomes the new picture, 2, 4 ... times larger; every
    layer, mask and the selection are scaled along. One Ctrl+Z takes it all back. A picture larger than the model
    takes (4096 px on the long side for the shipped ones) is refused before anything is sent; upscale a selection
    of it instead.
- **Nine upscale models**, in their own *Upscale* group of the recipe list:
  - through **fal.ai** (your fal key, no Topaz account needed): *Topaz Precision* (Standard, High Fidelity, Low
    Resolution, CGI, Text Refine, Faces), *Topaz Bloom*, *Topaz Wonder / Redefine*, *Clarity Upscaler* (your prompt
    guides the added detail), *SeedVR2*, *Recraft Crisp* and *Recraft Creative*;
  - through **Magnific** (a new key row under *Settings › API providers*): *Magnific Precision* (2 to 16 times) and
    *Magnific Creative* (2, 4, 8 or 16 times, your prompt as guidance). Every Magnific API call costs credits, even
    on a web plan that says "unlimited";
  - *Magnific Precision*, *Magnific Creative*, *Recraft Crisp* and *Recraft Creative* also run on **Comfy Cloud**,
    billed in Comfy credits.
  Each model's own settings (model, sharpen, denoise, creativity, ...) are in the Settings panel as for any recipe.
  **Topaz can take several minutes** on a large picture; the status line says so, and the window stays usable.
  None of the upscalers has run against a live API yet.
- **For agents and the assistant:** a new `upscale` command and MCP tool (`scope` selection or document, `factor`);
  `list_recipes` names each recipe's task and factors. The assistant asks before it upscales, as before it
  generates.

## 0.1.23 — 2026-09-21

- **Layer names are visible again, and can be renamed.** A layer row was a little wider than the panel, so the
  name was squeezed to nothing: you saw the eye, the thumbnail and the IMAGE / RESULT select, but no name to
  double-click, the delete button was cut off, and the layer list scrolled sideways
  ([#1](https://github.com/DenRakEiw/scumble/issues/1)). The panel on the right is 320 px wide now instead of 290,
  the row's buttons are a little more compact, a name always keeps at least 48 px, and the rows of a text layer wrap
  instead of running past the edge. Double-click a name to rename the layer, as the tooltip always said; **the
  rename is an undo step now**, so Ctrl+Z puts the old name back.
- **Qwen Image Edit 2.1 on your own ComfyUI.** A new local recipe, *Qwen Image Edit 2.1 (ComfyUI)*, built from
  ComfyUI's own template: the crop is `<image1>`, the next two pictures of the crop (the *Original* copy, reference
  layers) are `<image2>` and `<image3>`, 25 steps, CFG 1, the result at the crop's size. Model, text encoder, VAE,
  steps, CFG and resolution are in the Settings panel. It needs a current ComfyUI (with `TextEncodeQwenImage21`) and
  the three Qwen Image 2.1 model files, whose download links the recipe lists. Checked against a real ComfyUI's node
  definitions, not run yet.
- **An *upscale* use case for prompt upsampling.** Pick *upscale* next to the Upsample button and the language model
  describes what is already in the picture, with the fine detail (textures, pores, fabric, hair, crisp edges) an
  upscale or refinement pass should bring out, and is told not to add, remove or change anything. Whatever you type
  goes along as guidance on style and detail. Your own prompt templates see it as `{useCase}` = `upscale`.

## 0.1.22 — 2026-09-20

- **Your own language models, for the assistant and for prompt upsampling.** *Settings › Language models* is a
  list you fill: pick a provider (OpenRouter, OpenAI, Anthropic, Google Gemini, DeepSeek, Moonshot, Z.ai, ToAPIs,
  WaveSpeed or your local endpoint), type the model id that provider itself uses, and tick what it is for -
  *Prompt upsampling* puts it in the editor's *Upsample* list, *Assistant* puts it in the chat's model picker, in
  its provider's group. It runs on the key that provider already has under *API providers*, so no new key is
  needed; a provider without a key stays greyed out until you add one. Untick *Can see the picture* for a model
  without image input: it then never gets the crop, and the assistant leaves the screenshot tool out of its list.
  *Remove* takes a row out of both lists again.
  - For OpenRouter the id field suggests from OpenRouter's own live list of models that take tools, so any model it
    routes can be used without waiting for a Scumble release.
  - DeepSeek, Moonshot, Z.ai and WaveSpeed become prompt upsamplers this way too; until now their keys were only
    for the assistant.
  - Nothing checks that the id exists or that the model understands tools - that is between you and the provider,
    and its own message comes back into the chat or the status line.
- **The assistant's model picker no longer warns about itself.** Every row used to end in "not tried with a real
  key", on all ten providers, which read as a warning about Scumble rather than about a model. A row now says only
  what is true of that model ("cannot look at the picture", a provider's preview note). That nothing has yet
  completed a task against a live API is said once, in `docs/ASSISTANT.md` and in these notes, not on every row.

## 0.1.21 — 2026-09-20

- **OpenRouter as a provider.** One key from [openrouter.ai](https://openrouter.ai) runs GPT Image 2 and 2.5
  (Flare, Sunburst), Nano Banana 2, 2 Lite and Pro, FLUX.2 max, pro and flex, Seedream 5 lite and pro and Grok Imagine
  2.0, and, in *Generate a new image*, Krea 2 and Recraft V4. OpenRouter is listed after Comfy Cloud under *Settings ›
  API providers* and last in each of these models' provider choice; nothing moves to it by itself, every model keeps
  running where it ran until you pick OpenRouter for it (in *Settings › Recipes*, in *Generate a new image* or with
  `select_recipe(id, "openrouter")`).
  - **Not tried against the real service yet.** It is built from OpenRouter's documentation and its public model list
    of 2026-09-19; if a run fails, *Help › Console › Copy all* has OpenRouter's own message.
  - **What leaves your machine:** the crop and your reference layers go to OpenRouter inside the request, and for GPT
    Image and Nano Banana the selection's mask as a second picture (OpenRouter has no mask input, so the prompt tells the
    model what the mask means). OpenRouter passes them to the model's host. Scumble asks it to leave out every host it
    lists in China, and sends nothing that would put Scumble on OpenRouter's public app pages. Qwen Image 3 is not
    offered through OpenRouter, because its only host there lists a datacentre in China.
  - FLUX.2, Seedream and Grok edit the whole crop, and Scumble keeps only the selected part of the answer, as with the
    other providers without a mask; say "fill the green area" with *Fill* set to green for area-directed edits.
  - *Resolution* on *auto* picks the smallest size tier that still covers your crop. OpenRouter takes no pixel size, so
    an answer of another shape than the crop is centre-cropped into place.
  - If the pictures of one run come to more than 18 MB, the crop and the references without transparency are sent as
    JPEG; if that is still too much, the run is refused before anything is sent, with a note to set *Highres fix*
    lower, turn *Original* off or use fewer reference layers.
  - *check balance* next to the stored key shows what the key may still spend when you gave it a limit on OpenRouter,
    and what it has used when you did not; the account's credits are shown only on openrouter.ai.
  - *Resolution* 4K on Nano Banana Pro goes only to Google AI Studio, the one host of that model that offers it there.
  - A run OpenRouter turns away for a moment (too many requests, an overloaded host) is sent once more after the wait
    it asks for; if it asks for more than a minute, the message says when to try again instead.
- **BytePlus ModelArk for Seedream.** Seedream 5 pro and lite now also run on ByteDance's own API, BytePlus ModelArk,
  with a key from its console. It is listed after OpenRouter under *Settings › API providers* and right after ToAPIs
  in the two Seedream models' provider choice; fal stays their default, nothing moves by itself.
  - **Not tried against the real service yet.** Built from BytePlus' API reference; in the ModelArk console the model
    has to be activated first, and a key works only in the region it was made in.
  - **What leaves your machine:** the crop and your reference layers go to BytePlus inside the request: to Johor,
    Malaysia, or, for Seedream 5 lite with *Region* set to eu-west, to Dublin (BytePlus may route a request to its
    other region, names data centres in Malaysia, Indonesia and the EU/EEA for its processing, and keeps what its
    content filter flags for 180 days in Malaysia). The answer comes back in the same request, without the
    "AI-generated" watermark ModelArk adds unless told not to. BytePlus' list of the countries it serves (21 April
    2026) has Germany and the rest of the EU, but not the United States.
  - The answer has your crop's own shape, at a size inside the model's range: Seedream 5 pro 0.9 to 4.6 megapixels
    (up to 2.6 MP costs $0.045, above that $0.09, and every picture after the first adds $0.003; with *Highres fix* on
    *Maximum* a crop goes out at up to 4.6 MP), Seedream 5 lite 3.7 to 16.8 megapixels ($0.035). *Generate a new
    image* gets exactly the aspect you pick.
  - No mask input: the model edits the whole crop and Scumble keeps only the selected part; say "fill the green area"
    with *Fill* set to green for area-directed edits.
  - A picture steeper than 16:1, larger than 36 megapixels, or over 30 MB with transparency is refused before anything
    is sent; one over 30 MB without transparency is sent as JPEG.
- **Prompt upsampling on the OpenRouter key:** with an OpenRouter key stored, Gemini 3.8 Flash, GPT-5.6 Luna, Claude
  Haiku 4.5 and Mistral Small 4 join the upsample list after the other API models. OpenRouter is asked to use only
  hosts that do not train on your text and picture, and none in China.
- **Upsampling errors never show your key**, on any provider, even if a server repeats it in its answer; a model that
  declines to rewrite the prompt now says why instead of "content_filter", and an answer that breaks off with an error
  partway through is no longer taken as the prompt.
- The descriptions of the MCP commands `select_recipe` and `upsample_prompt` name OpenRouter (and ToAPIs).
- **FLUX.2 [flex] on fal ran with 2 steps.** Its *Steps* and *Safety tolerance* rows shared one settings slot, so the
  panel showed *Safety tolerance* where *Steps* belonged and sent that value as the step count as well: a run with the
  defaults asked fal for 2 steps instead of 50. The three rows (*Steps*, *Guidance*, *Safety tolerance*) are three rows
  again. Only FLUX.2 [flex] on fal was affected; the same model on Black Forest Labs, ToAPIs, Replicate, WaveSpeed and
  OpenRouter was right, and so is every other recipe.
- **A recipe with several providers can be imported.** *Settings › Recipes › Import* took an API recipe only in
  the old shape with a single provider and turned away the shape every shipped recipe has, so you could not copy one,
  add a model of your own to it and bring it back in. It imports now, with all its variants, and the note says which
  providers came in; a copy that keeps the shipped id replaces that recipe in the list, as a copy put into the recipes
  folder by hand always did.
- **The assistant: a chat column that drives the editor.** Open it with the *Assistant* button in the bar,
  *View › Assistant* or Ctrl+Shift+A. You write what you want; it selects, adds layers, sets the prompt, renders,
  colour matches and exports through the same commands an external agent gets - and you watch every step as a card.
  It runs on your own API key, on **all four model families**: Anthropic (Claude Sonnet 5, Opus 5), OpenAI
  (GPT-5.6 Terra, Sol, Luna), Google (Gemini 3.8 Flash, 3.1 Pro preview, 3.5 Flash-Lite) and every
  OpenAI-compatible endpoint - OpenRouter (any tool-capable model id it lists), DeepSeek, Moonshot / Kimi, Z.ai /
  GLM, ToAPIs, WaveSpeed and your own local server. The picker is grouped by provider; a provider without a key is
  greyed out, and every model says whether it can look at the picture. `docs/ASSISTANT.md` is the whole thing in
  one page.
  - **Not tried against a live model yet.** Every family was built from its documentation and proven against the
    real hosts as far as a key without credit allows: each one builds its request, reaches its host and reads the
    answer. No model has completed a task here, and the picker marks every provider "not tried with a real key".
  - **What asks before it acts:** everything that can cost money or queue on your ComfyUI (*generate*,
    *generate new*, *select by text*, *cutout*, *upsample*), everything that clears the undo stack or bakes your
    layers in (*flatten*, *extend canvas*, *new canvas*, *load image*), and every edit to a layer that is not the
    assistant's own. Neither button of a card is the default, and Enter in the chat never answers one. An export
    without a path is refused outright.
  - **What leaves your machine:** your messages, a short note on the open documents (names, sizes, layer names),
    the results of the tools it called and the screenshots it took - to the provider you picked and to nobody
    else. Scumble asks none of them to keep the conversation, and the panel shows a one-line notice per provider
    the first time you send to it.
- **The assistant's chats are kept**: every chat is saved as it goes, with its screenshots beside it, and the
  panel's *Chats* button reopens one - on the model it was written with, or to read only. *Settings › Assistant*
  says how many chats to keep and how many tool calls one turn may take, and deletes everything the assistant ever
  stored, its lines in the app log included. **Your API keys stay.**
- **Everything the assistant does can be taken back.** Ctrl+Z undoes each of its steps, the ones the editor records
  no step for included (a new layer, a filter setting, a text, a colour match). And when a turn is done, the panel
  offers *Undo this turn*: every document it touched goes back to what it was before the turn's first change there
  - the pixels, the selection, the prompt and the settings - even when the turn was longer than the undo stack.
  Ctrl+Z takes that restore back in turn. It needs the tile engine; on the canvas backend a copy of every layer
  would cost too much memory. If you edited something yourself while the turn ran, the button says so before it
  discards your work.
- **Three more key rows: DeepSeek, Moonshot / Kimi and Z.ai / GLM** under *Settings › API providers*, after the
  Anthropic row (whose label now says the key also serves the assistant). They run no image model and no prompt
  upsampling: they are the assistant's. DeepSeek and Moonshot get *check balance* (their balance endpoints; not
  tried against the live services); a Moonshot key has to come from platform.kimi.ai, and a Z.ai key has to be a
  pay-as-you-go key, not a GLM Coding Plan key.
- A file dropped on the tab bar or a panel no longer navigates the window away from the editor, and a
  command an agent had sent while it happened no longer waits forever.

## 0.1.20 — 2026-09-19

- **Large JPEG, WebP and colour-profiled PNG files open without freezing the window.** Opening a 15000 × 10000 picture
  used to hold the window for one to four and a half seconds while the browser decoded and read it; the picture is now
  decoded by a background worker and the window stands still for well under a tenth of a second: a JPEG 0.1 s instead
  of 1.0, a JPEG with an Adobe RGB profile 0.03 s instead of 3.7 (and it is ready after 1.1 s instead of 3.8), a WebP
  0.04 s instead of 1.7, a PNG with a colour profile 0.05 s instead of 4.4. The same happens when such a file is added
  as an image layer and when Scumble reopens your documents at start. The pixels are exactly the ones you got before:
  colour profile, EXIF rotation and transparency are applied the same way.
- **An API run no longer freezes the window while it cuts the crop and stitches the answer back.** On a 15000 × 10000
  document with a colour-matched result layer and a film look, preparing the crop held the window for 6.3 seconds (1.5
  without the film look); now for 0.05. The crop, its masks and the stitched result are made in the background, from
  the same picture: the files sent to the provider and the result layer are the same bytes as before on a plain
  document; with a colour-matched layer the crop can move by the few levels the saved files already moved by in 0.1.19.
- **Letting go of the brush or the eraser is smoother on large documents.** The stroke is written into the layer tile
  by tile instead of through large temporary pictures: a long erase across a 15000 × 10000 layer held the window for
  0.29 seconds on release, now 0.07; a stroke on a colour-matched result layer under a film look 0.07 to 0.09 seconds,
  now 0.035. Soft or semi-transparent paint can differ from before by one level, which cannot be seen.

## 0.1.19 — 2026-09-18

- **Documents with a colour-matched layer save and select as fast as plain ones.** A layer whose colours are matched to
  its surroundings (or to what is underneath it) no longer sends the whole document the slow way: the background
  workers now read the match's statistics from the picture's tiles and apply the match themselves while they put the
  layers together. A 15000 × 10000 picture with a 5000 × 3500 matched result layer saves as PNG in 1.8 seconds instead
  of 6.4, with the window standing still for 0.08 seconds instead of 1.4; as PSD in 1.0 instead of 1.8; and a magic
  wand click across it takes 0.9 seconds instead of 2.5, the window standing still for 0.1 seconds instead of 1.1. A
  matched layer with a film look or another filter layer above it takes the fast way too; one with a filter layer
  below it is saved as before. **A matched layer's colours can move by a few levels** against the previous versions
  in a PNG, PSD or ORA export, in the picture a local ComfyUI run starts from, and under the magic wand and the
  bucket: their statistics are now taken from samples of the picture instead of the whole picture drawn small.
  Measured on four photos with a cut-out result layer matched at full strength: on average 0.1 to 2 levels, at most
  7 on a textured landscape; on smooth pictures 1 to 2. A JPEG or WebP export, the picture an API provider is sent,
  a merge into the base and what the screen shows are unchanged, so those can differ from a PNG of the same document
  by the same few levels.
- **`set_layer` with `match_source` "below" now matches against the pixels underneath the layer.** The value was
  stored as it came and read as "surroundings", so an agent could not ask for the other source.
- Under the hood: the editor's worker plumbing, PNG encoders and uploads live in three files of their own
  (`inpaint_jobs.js`, `inpaint_encode.js`, `inpaint_upload.js`), moved out of `inpaint_canvas.js` as they were.
  Nothing changes for the user; the ComfyUI node is built from the same files.

## 0.1.18 — 2026-09-18

- **Documents with filter layers save about twice as fast, and the magic wand on them no longer freezes the window.**
  When a document holds filter layers between ordinary layers, the background workers now put the layers together, the
  graphics card runs the filters on exactly those pixels, and the result comes back once, instead of every band of the
  picture being drawn through the browser's canvases. A 15000 × 10000 picture with three full paint layers and a levels
  layer saves as PNG in 1.4 seconds instead of 6.2; with the film look on top in 5.0 instead of 9.1, and the window
  stands still for 0.13 seconds instead of 1.2. A magic wand click across such a picture takes 1.5 seconds instead of
  3.3, the window standing still for 0.16 seconds instead of 1.2. Layers above a filter, several filters, and a filter
  with an opacity, a blend mode or a mask are all covered; a document with a colour-matched or a scaled layer is saved
  as before. The pixels can differ from the old way by one level in places, a filter that sharpens by one more.
- **Documents with blend modes save and select as fast as plain ones.** A layer set to multiply, screen, overlay,
  darken, lighten, soft light, hard light or difference no longer sends the whole document the slow way: the background
  workers now know the eight blend modes, and compute them more exactly than before (never more than half a level from
  the exact value). A 15000 × 10000 picture with a full multiply layer saves as PNG in 1.6 seconds instead of 3.4 and
  as PSD in 1.1 instead of 3.8, and a magic wand click across it takes 1.1 seconds instead of 3.9, with the window
  standing still for 0.1 seconds instead of 1.2. The wand selects the same pixels as before; a saved picture can
  differ from the old way by one level where a blended layer is partly transparent.
- **Opening a large PNG no longer freezes the window.** A PNG of 32 megapixels and more that needs no colour
  management (8 bits, no colour profile, no gamma entry) is now read by a background worker straight into the tile
  engine, the way pictures above 268 MP already were. A 15000 × 10000 file opens in 2.7 seconds instead of 3.2, and
  the window stands still for 0.1 seconds instead of 2.1. The pixels are the same. Files with a colour profile, 16-bit
  files, JPEG and WebP open as before.
- **Grow, shrink and feather of a large selection are faster and hardly hold the window.** A background worker now
  reads the selection straight from its tiles and sends back only the pieces that changed. Growing a 6000 × 4000
  selection by 16 px on a 15000 × 10000 picture takes 0.5 seconds instead of 0.7, shrinking 0.3 instead of 0.6, and
  the window stands still for 0.09 and 0.02 seconds instead of 0.2. Grow and shrink give exactly the same selection as
  before; a feathered edge can differ by a few levels of softness, because the browser's blur is not the same twice.
- **The magic wand and the bucket are about three times as fast on large pictures.** On a document without a
  colour-matched layer the background workers now put the picture under the wand together
  from the layers' tiles and search it there, and the wand's selection comes back as finished pieces instead of a
  picture that has to be drawn into the selection. A wand click that selects 58 million pixels of a 15000 × 10000
  picture takes 1.4 seconds instead of 4.2, and the window stands still for 0.2 seconds instead of 1.6. The selection
  and the fill are the same as before, pixel for pixel.
- **Saving a large picture is about twice as fast again.** When a document holds only ordinary layers (normal blend
  mode, any opacity, with or without a transparency mask; no filter layer, no colour match), the background workers now
  put the picture together themselves, straight from the layers' tiles, while they compress it. A 15000 × 10000
  picture with a full paint layer saves as PNG in 1.7 seconds instead of 3.5 and as PSD in 1.3 instead of 3.9, and the
  window stays free the whole time. (Blend modes and filter layers follow in the two entries at the top; a document
  with a colour-matched layer is saved as before.) The pixels can differ from the old way by one level in places where layers are partly transparent (the
  browser's own canvases differ from each other by more).
- **A run through an API provider starts and lands faster.** Before the picture goes out and when the result comes
  back, Scumble works out the soft masks that blend the result into the image. On a 1024 px selection that froze the
  window for about 2.5 seconds; it is about 0.6 seconds now, with exactly the same masks.

## 0.1.17 — 2026-09-17

- **Pictures larger than 268 megapixels open.** Chromium cannot hold a canvas above 268 MP, and until now neither could
  Scumble. A PNG of that size is now read piece by piece straight into the tile engine: a 30000 × 20000 file (600 MP,
  1.1 GB) opens in about 10 seconds, and you can pan, zoom, paint, select, run a model on a selection, undo and close
  and reopen it like any other document. Such a document is saved as **PNG, PSD or ORA at its full size**; JPEG, WebP,
  a reduced size and the steps that rebuild the whole picture (resize, extend) need one canvas of it and say so instead
  of writing an empty file. The limits now are 65,535 px a side and one gigapixel. Only PNG files are read this way,
  and only with the tile engine on.
- **Saving no longer freezes the window.** A PNG is now written in strips: the picture is put together a strip at a
  time and up to eight background workers compress the strips at once. On a 15000 × 10000 picture the window used to
  stand still for 2.4 seconds while the file was made; now it keeps answering, and a progress figure counts up in the
  status line. The whole save takes longer than before on such a picture (about 6 seconds instead of 3.5), because the
  strips are put together more slowly than one big picture was. The files are **less than half the size** (the
  compression is better than the browser's own). The same goes for *Flatten*. With a colour-matched layer in the
  document the save works as before.
- **PSD and ORA are written faster and without a copy of every layer.** A layer is read straight from its tiles and
  packed by the background workers; a 6000 × 4000 document with three layers takes 0.8 s instead of 1.1 s, and the
  window stays free.
- **Autosave of a large painted layer: 0.8 s instead of 1.2 s, and the window no longer stutters for it** (6 ms instead
  of 190 ms on a full 15000 × 10000 layer). Layers and masks are compressed from their tiles by the background workers.
- **Vignette, Normalise, the film pack's Frame, Light leak and the film look's halation sit where they belong when you
  zoom in.** These filters belong to the whole picture, but they were worked out on whatever part of it the screen
  showed: zoomed in, the vignette darkened the corners of the view, the frame ran around the view, and the halation
  glow was as wide as if the view were the picture. They are now placed in the whole picture, so the screen shows what
  the saved file holds. Normalise takes its colour statistics from the whole picture as well; its result can differ by
  a level or two from earlier versions.
- **A model run on a large picture no longer flattens all of it.** Only the box that goes to the model is put together,
  and the selection is read around its own pixels instead of across the whole picture (on a 15000 × 10000 picture that
  was 600 MB read and another 600 MB of working memory per run).
- **The picture's detail levels come back faster after a change of a whole layer.** After a flip, a turn or an undo of a
  whole layer the screen shows a coarse picture until the smaller copies of the layer are rebuilt. They are now built
  by up to eight background workers at once, which read the layer's pixels where they lie in memory instead of getting
  a copy: on a 15000 × 10000 picture the screen is exact again after about 0.15 s instead of 0.35 s.
- Plugins: a filter can be placed in the whole picture (`info.full`, `info.origin`, `u_pictureSize`, `u_pictureOrigin`,
  `pictureUv()`), ask for the whole picture's colour statistics (`wholeStats`) and size its `reach` by the picture
  (`docs/PLUGINS.md`).

## 0.1.16 — 2026-09-17

- **Grow, shrink, the magic wand and the picture's detail levels run as compiled code (Rust).** The pixel work behind
  *Grow* and *Shrink*, the magic wand and the bucket, and the smaller copies of every layer the screen draws from now
  runs as WebAssembly instead of JavaScript, with the same results to the last bit. On a 15000 × 10000 picture growing a
  large selection takes 0.6 s instead of 1.0 s, a magic wand across the whole picture 3.1 s instead of 4.6 s, and the
  detail levels after a change of a whole layer are built about 1.4 times as fast. Where the compiled code cannot load,
  the JavaScript runs as before.
- **A colour-matched layer no longer costs a gigabyte on a large picture.** With the tile engine on, a layer with
  *Colour match* switched on was matched on a full-size copy of itself (and of its mask) every time the view, the
  eyedropper or the magic wand looked at it: on a 15000 × 10000 picture with a full-size matched layer that was **1.1 GB**
  of memory, **0.8 s** for the first frame at 100 % and a pan of 50 to 100 ms a frame. Only the part on screen is matched
  now, straight from the layer's tiles: **0.13 s**, a pan of 3 ms, and no copy at all. A matched layer can look up to a
  few levels different from before at its edges and in its colours, because its colour statistics are now read from the
  layer itself instead of a scaled-down screen copy. With the tile engine off nothing changes.
- **The screen, the navigator and the eyedropper agree on a colour-matched layer.** The screen used to take a
  matched layer's colour statistics from whatever part of the picture was in view right after a change, while the
  eyedropper, the magic wand and the *Film looks* thumbnails took them from the layer's whole surroundings: the screen
  could show the layer a few levels different from what the eyedropper picked, and after a change its colours depended
  on where you were looking. All of them now use the same statistics, on both engines. A matched layer on screen can
  look up to 3 levels different from before; exports and renders are unchanged.
- **Cropping, resizing, extending, flattening and their undo no longer decode the picture again.** Each of these
  used to save the new picture, load it back as an image and decode it once more, and kept the decoded image in
  memory for every undo step as well (about 570 MB each on a 15000 × 10000 picture); an undo of a crop or a flatten
  then decoded the old picture again, half a second or more. The picture is now kept once, an undo puts it straight
  back, and a crop with the tile engine on shares the unchanged parts of the picture instead of copying them. A resized
  picture can come out up to a few levels different from before (a different, equally fine resampler).
- **Brush strokes and selections keep less in the undo history.** With the tile engine on, the undo step of a stroke
  copied every 256-pixel block its rectangle overlapped, even the parts the stroke never changed, and blocks a
  discarded step had shared stayed marked as shared, so the next stroke copied them again. A step now keeps only the
  blocks the stroke really changed, and undoing a stroke on a 15000 × 10000 picture takes about 26 ms instead of 43.

## 0.1.15 — 2026-09-16

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
- **The object tool and background removal start faster on large pictures.** With a helper model
  downloaded in *Settings › Helpers*, choosing the object tool used to flatten the whole picture
  twice at full size, save it as a PNG and store a copy, only to feed the model a 1024 px image; on a
  15000 × 10000 picture that input alone took **about 2 seconds** and 1.7 GB each time. With the tile
  engine on it now takes **under 0.2 s**, nothing is saved on the way, and moving the mouse over an
  unchanged picture no longer checks it again. The input for background removal went from 0.6 s to
  0.04 s. Showing the objects under the cursor on such a picture is still slow; that is next.
- **Fixed: the eyedropper and the magic wand could ignore a layer's colour match.** Right after a
  change, a click with the eyedropper on a colour-matched layer could pick the layer's original,
  unmatched colour, and from then on the wand, the bucket and the *Film looks* thumbnails also saw
  that layer unmatched until the picture changed again. The magic wand could also select a different
  area depending on when it was clicked. All of them now use the same colour match for a layer, taken
  from everything around it. On screen and in exports nothing changes.

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
