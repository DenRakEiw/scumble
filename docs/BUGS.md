# Bug list

Reported and not yet fixed. One section per bug: what was seen, what is already known
about it, and what has to be measured before anyone writes code. A bug leaves this file
when it is fixed (with the release it went out in) or when it turns out not to be one.

Fixed bugs are not kept here - `CHANGELOG.md` has them per release, `docs/PERFORMANCE.md`
the ones that were performance work.

---

## Open

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

### Erasing on a result layer switches to the base

**Reported** 2026-09-11 by DenRakEiw, on the same large document, on the result layer of a
Seedream 5 Lite run over a big area: erasing with the mouse button held switches the active
layer to the base underneath. This is the worst of the three, because the erase then goes to
the wrong target.

**Not identified.** What the code says so far:

- The pointer-up branch for `layerpaint` (`inpaint_canvas.js`) touches no layer selection at
  all, so the stroke itself is not doing it.
- The **only** place that reports switching to the base is the Ctrl+click auto-select
  (`e.ctrlKey && ... ["transform", "paint", "erase", "text"]`), which sets
  `activeLayerId = null` and says *"Base selected."* in the status line when nothing is hit.
  It needs Ctrl held, which the report does not mention.
- A removed layer also falls back to the base (`removeLayer`), and a still-*pending* result
  is discarded by `cancelPending()` on a layer-row click and on that same Ctrl+click path.

**Ask the user first**: does the status line say *"Base selected."* when it happens? That one
answer separates the auto-select path from everything else. Then whether the result layer was
still a pending result (the row with the Discard button) or an accepted layer.
