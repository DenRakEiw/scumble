# Bug list

Reported and not yet fixed. One section per bug: what was seen, what is already known
about it, and what has to be measured before anyone writes code. A bug leaves this file
when it is fixed (with the release it went out in) or when it turns out not to be one.

Fixed bugs are not kept here - `CHANGELOG.md` has them per release, `docs/PERFORMANCE.md`
the ones that were performance work.

---

## Open

### Erasing switches the active layer to the base

Reported 2026-09-11, same session as the vanishing layer (fixed in 0.1.8, see
`CHANGELOG.md`: the erase wiped the layer's cached display level outside the stroke's
rectangle, so the picture lost the layer while its pixels and its thumbnail kept it). A layer
that disappears from the picture after an erase looks exactly like the base having been
selected and erased on, so this report is **probably the same bug seen from the other side**.
It stays open until the user confirms on 0.1.8, or answers the question below.

Erasing on a result layer with the mouse button held switches the active layer to the
base underneath.

**Not identified as a bug of its own.** The pointer-up branch for `layerpaint` touches no layer
selection at all, and the reproduction of the vanishing layer (real pointer events, a
selection, 400 px at 43 %) left `activeLayerId` on the result layer every time.
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

**Measured 2026-09-12** (dev instance on its own profile, the app freshly started, synthetic
15,000 × 10,000 document: base, three full-size paint layers, one 2048² result layer, a film
look; `tools/perf_test.py 15000x10000` plus a script that drove the real pointer handlers on
the screen canvas). The drawing itself is **not** slower than the screen: pan, an eraser
stroke with a 400 px tip and its release each take one 120 Hz frame (8.3 ms median, both at
fit zoom and at 1:1), slider ticks 8 ms, the release of an erase over 12,400 × 6,400 px
13 ms commit plus 1.5 ms pyramid refresh, the autosave upload of three changed layers holds
the main thread 19 ms at most (2 s wall, in the worker). What does stutter:

| Step, 150 MP | main thread held |
|---|---|
| first frame after a zoom to 1:1 (full-resolution textures) | 58 ms, once 320 ms in a real pan |
| selection change (`pushUndo` copies the selection canvas) | 62 ms |
| undo step | 99 ms |
| selection bounds scan | 83 ms, worst 754 ms |
| grow +16 / shrink / invert / feather | 321 / 180 / 70 / 135 ms |
| magic wand / bucket | 2076 / 1646 ms |
| PNG of the composite (undo of a whole layer, autosave, export) | 274 ms even with the worker |
| full composite (before a run or export) | 9 ms warm, 990 ms cold |

And the memory, which is the finding that matters: **one 15k document with three full layers
holds 4.3 GB in the GPU process** (`ed.memoryReport()`: layers 1.8 GB, display pyramids
1.0 GB, base canvas 0.6 GB, selection canvas 0.6 GB, compositor textures 0.2 GB at fit zoom
and 1.26 GB after a zoom to 1:1). The GPU process went from 8.1 GB (after the benchmark's own
15k document had been closed) to 14.9 GB with the document built and 17.4 GB after the
gestures. Every one of those canvases is a GPU texture in Chromium's GPU process, and it
competes for the card's 32 GB with ComfyUI (20 to 29 GB right after a local render, measured
on 2026-09-08), Photoshop (9.5 GB dedicated while it had a document open, WDDM counters
`\GPU Process Memory(*)\Dedicated Usage`) and Krita. When the card is over-committed Windows
pages GPU memory to system RAM and every frame that touches an evicted texture stalls: that
is a stutter no benchmark on an otherwise idle card shows, and it is the first thing to
verify on the user's machine (Task Manager › GPU › dedicated memory while it stutters, and
whether it is smooth right after a restart of ComfyUI). The user's real 15k file could not
be measured: it was not open (their autosave held a 2 MP document, their GPU process 774 MB).

**What to measure first** (before touching anything)

1. ~~The exact dimensions of both files, `ed.memoryReport()` and `app:metrics`~~ done above on
   a synthetic document of the reported size; the user's own file is still to be read the
   same way (Help › Console, `window.editor.memoryReport()`, `window.scumble.metrics()`).
2. ~~`perf_test.py 15000x10000` against 12000x8000~~ done: within a frame of the 96 MP numbers
   for every interactive row; the discrete rows are in the table above.
3. **Dedicated GPU memory of the whole card while it stutters** (Task Manager › Performance ›
   GPU, or the WDDM counters), and the same document right after ComfyUI has been restarted.
   If the stutter goes with the free VRAM, the fix is memory, not drawing.
4. A CDP heap snapshot if the memory climbs across gestures rather than sitting flat. The
   canvas census says *what* survived, only the retaining path says *why*.
5. Whether the stutter is periodic. `watchMemory` runs every 30 s but only touches background
   tabs; the autosave runs 15 s after the last change and was measured at 19 ms blocked.

**Likely fix, if the measurement confirms the memory reading**: layer tiles above a
threshold, which is the one piece of the performance plan that was left out on purpose, and
with them the pixels of layers that are not on screen kept out of the GPU process (in the
renderer as typed arrays, or in the mirror) instead of as one accelerated canvas each. That is
what Krita and Photoshop do (`docs/PERFORMANCE.md` §3: tiles in system RAM, a mipmapped
projection of the *merged* picture, the GPU holds only the visible tiles) and it is why they
do not fight ComfyUI for VRAM. A tiled layer also makes the whole-document steps in the table
(selection undo, bounds scan, wand, bucket) per-tile work. It is a large piece of work and
belongs to the user's decision, not to a quick patch. The plan for it is
`docs/PLAN_TILES.md` (written 2026-09-12): quick wins first, a Rust spike, then the tile engine.
