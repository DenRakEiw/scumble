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
and painting stutter badly. The user re-saved the same picture as JPEG to compare and the
comparison is still running, so "PNG is the problem" is the *report*, not a finding.

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
- **The file format should not matter once the image is decoded.** Base and layers live as
  RGBA canvases; PNG and JPEG of the same pixel size cost exactly the same to draw. If the
  JPEG really is smoother, the cause is somewhere else and worth finding, because it would
  contradict the model we have of the pipeline. Two candidates:
  - the PNG encode on the autosave and upload path (`canvasBytes`, the worker). A 150 MP PNG
    encode is expensive and happens on a change, a run and at autosave time.
  - the JPEG may simply be smaller: the Export row added in 0.1.6 can save at a percentage,
    so the two files may not be the same pixel size at all.

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
