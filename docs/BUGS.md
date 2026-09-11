# Bug list

Reported and not yet fixed. One section per bug: what was seen, what is already known
about it, and what has to be measured before anyone writes code. A bug leaves this file
when it is fixed (with the release it went out in) or when it turns out not to be one.

Fixed bugs are not kept here - `CHANGELOG.md` has them per release, `docs/PERFORMANCE.md`
the ones that were performance work.

---

## Open

### A whole layer disappears when the eraser is nowhere near it

**The worst of the open ones, and the one to start with.** Reported 2026-09-11 by DenRakEiw
with two screen recordings:

- `C:\Users\schoeneberg\Videos\2026-09-11 22-19-50.mp4` (19 s): painting a 400 px hard brush
  on a result layer leaves a hard-edged red rectangle, and erasing takes rectangular chunks
  out of it. The layer thumbnail is a solid red rectangle. That layer carried an RMBG-2.0
  cutout and Match 2 % / surroundings.
- `C:\Users\schoeneberg\Videos\2026-09-11 22-24-49.mp4` (5 s): a cat on a result layer,
  *Result 5 added (2236 x 1853 at 8132, 5545)* on a roughly 15,000 px document. The eraser is
  400 px at 43 % hardness. Its ring is visibly about 80 screen pixels clear of the cat, one
  stroke, and **the entire cat is gone**. The layer is not deleted; the picture just loses it.

Frames come out with ffmpeg, which is on this machine:
`ffmpeg -i "<video>" -vf "fps=3,scale=1600:-1" frames/f%03d.png`.

**One cause is found and fixed, and it is not this one.** The brush ring used to be a one
pixel line in the paint colour, so it vanished over its own paint, and a brush wider than the
layer looked like a tool that fills rectangles. That is what the first video mostly shows,
and the ring has a dark halo now. It does **not** explain the second video, where the ring is
plainly visible and plainly not on the cat.

**What was tried and did not reproduce it** (all on a dev instance with its own
`--user-data-dir`, driving the editor through `tools/cdp.py eval`):

- A layer whose canvas is far higher resolution than its placement (1024 px of pixels shown
  as 300 px of image). The dab scaling is **correct**: a 40 px brush paints 41 image px
  across, 100 paints 101, and 400 on a 300 px layer covers it completely, which is arithmetic
  and not a bug.
- A 2236 x 1853 layer at 8132, 5545 on a 15000 x 10000 document, one soft erase stroke 600
  layer pixels clear of a green block: the block survives untouched.
- The same with `match = 0.02` and `matchSource = "surroundings"`: layer pixels and the
  composited view agree, nothing is lost.

So the plain paths are fine and the trigger is something the reproduction did not have.

**What to try next, in this order**

1. **The stroke buffer and `strokeClip`.** The reproductions called `layerDab` and
   `commitStroke` by hand. The real gesture goes through `onPointerDown`, which builds the
   stroke buffer *and* the clip canvas from the selection. A selection was present in both
   videos. If `strokeClip` maps the selection into the layer wrongly for a layer at a large
   offset, the erase could land on the whole layer. Drive the real pointer handlers, do not
   shortcut them.
2. **The layer mask.** The first video's layer had an RMBG-2.0 cutout, so `layer.mask` and
   `_maskedValid` are in play, and `markLayerChanged` / `markMaskChanged` are separate paths.
3. **Is it pixels or is it the screen?** Read the layer's own alpha count before and after,
   *and* composite the stack, the way the reproduction above does. If the pixels survive and
   the picture does not, it is the display-version class of bug that bit twice before (the
   0.1.5 stroke that never reached the screen, and the colour match that read a cleared
   target), and the answer is in `touchSourceRect` and the compositor's texture cache.
4. Ask for the document if it cannot be reproduced synthetically: `%APPDATA%/Scumble/autosave.json`
   plus the file mirror holds the real one.

### Erasing switches the active layer to the base

Reported 2026-09-11, same session, possibly the same bug as the one above seen from another
side. Erasing on a result layer with the mouse button held switches the active layer to the
base underneath.

**Not identified.** The pointer-up branch for `layerpaint` touches no layer selection at all.
The **only** code that reports switching to the base is the Ctrl+click auto-select, which sets
`activeLayerId = null` and writes *"Base selected."* to the status line when nothing is hit;
it needs Ctrl held, which the report does not mention. A removed layer also falls back to the
base, and a still-*pending* result is discarded by `cancelPending()` on a layer-row click and
on that same Ctrl+click path.

**Ask the user**: does the status line say *"Base selected."* when it happens? That one answer
separates the auto-select path from everything else. The question was put on 2026-09-11 and is
still unanswered.

### A very large PNG stays jerky to work on

**Reported** 2026-09-11 by DenRakEiw, on a PNG about 15,000 px on its long side. Panning
and painting stutter badly.

**The file format is ruled out.** The user saved the same picture as JPEG and it is not
smoother (2026-09-11), which is what the pipeline predicts: after decoding, base and layers
are RGBA canvases and the format cannot matter. So the heading is misleading and the bug is
about the *size*. It is the untiled full-resolution layers that are the suspect.

**What is already known**

- The GPU compositor still applies at that size: it refuses only above `MAX_TEXTURE_SIZE`,
  which is 16,384 on this machine (`inpaint_compositor.js`, the `w > this.maxTexture` guard),
  and 15,000 is under it. So this is not the documented fall-back to Canvas 2D.
- **Layer tiles were deliberately not built** (`docs/PERFORMANCE.md` §"what is left"). Every
  source canvas is one texture and one full-resolution pyramid level, so a 15,000 × 10,000
  document holds about 600 MB per layer in the GPU process before anything is drawn. The
  memory watch (`settings.memory.gpuLimitMB`, default 3072) then releases caches on a timer,
  which is itself visible as a stutter.
- Phase 6 measured that four 96 MP documents open at once really are 19 GB of live pixels
  and about 40 ms a frame. 150 MP in one document is the same territory.
- **Every discrete step snapshots the whole document.** `clearSelection()`, and every
  selection change, calls `pushUndo({ kind: "selection" })`, which copies the selection
  canvas: 150 million pixels per step. Phase 1 made *brush* undo a copy of the touched
  rectangle only, but the selection steps were not part of that. On a document this size
  that alone can be the stutter.
- **Releasing an erase stroke is its own stutter** (reported separately in the same session:
  the stroke itself follows, the hitch comes on mouse up). The `layerpaint` pointer-up runs
  `strokeRect`, `commitStroke` and `markLayerChanged(layer, box)`, which refreshes the display
  pyramid over the touched rectangle and re-uploads the layer's texture. With a big eraser
  over a big area that rectangle is most of the document, so the "only the touched rectangle"
  saving from phase 1 buys nothing here.

**What to measure first** (before touching anything)

1. The exact dimensions of both files, and `ed.memoryReport()` plus IPC `app:metrics` with
   each one open. The bytes are in the **GPU process**, not the renderer.
2. `python tools/perf_test.py 15000x10000` against the recorded numbers at 12000x8000, on a
   freshly started app - the GL path degrades badly after several large documents in one
   session, so a stale instance gives nonsense.
3. A CDP heap snapshot if the memory climbs across gestures rather than sitting flat. The
   canvas census says *what* survived, only the retaining path says *why*.
4. Whether the stutter is periodic. `watchMemory` runs every 30 s; a stutter on that beat is
   the cache release, not the drawing.

**Likely fix, if the measurement confirms the memory reading**: layer tiles above a
threshold, which is the one piece of the performance plan that was left out on purpose. That
is a large piece of work and belongs to the user's decision, not to a quick patch.
