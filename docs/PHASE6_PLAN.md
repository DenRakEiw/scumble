# Phase 6: memory and the session degradation — implementation plan (2026-09-10)

This is the step-by-step plan for the phase described in `docs/PERFORMANCE.md`
§ "Phase 6". It was written after reading the code; the line numbers refer to the
state at commit `0e7daf8` (app) and `7508161` (node). Work through it top to bottom.
**Step 1 is instrumentation, and nothing in step 2 is built until step 1 reproduces
the symptom with a number.**

## 0. Ground rules for this phase

- **Where to edit.** `renderer/editor/inpaint_canvas.js` and
  `renderer/editor/inpaint_compositor.js` are synced copies: change them in the node
  repo (`F:\Comfyui\ComfyUI_windows_portable_nvidia\ComfyUI\custom_nodes\ComfyUI-InpaintCanvas\js\`),
  then `python tools/sync_editor.py`. The node repo is clean at `7508161`.
  `renderer/editor/inpaint_filters_gl.js` is **app-only** (not in the sync list): edit in
  place. `electron/main/main.js`, `electron/preload.js`, `renderer/shell.js`,
  `renderer/editor/host.js`, `tools/*.py` are app files.
- **Measure on a fresh instance.** The symptom is that numbers drift within a session,
  so every benchmark run starts the app anew:
  `./node_modules/.bin/electron . --remote-debugging-port=9555` (Bash tool,
  `run_in_background`), stop with `Stop-Process -Name electron`. The installed app
  holds the single-instance lock: close it first, or start the dev instance with
  `--user-data-dir`.
- **The symptom to reproduce** (seen twice, `docs/PERFORMANCE.md` phase 6 item 2): after
  four 96 MP documents were built and closed in one page, a `levels` filter tick cost
  12 ms instead of 0.8 ms and a film stack 70 ms instead of 6.
- **Targets** (from the plan): after opening and closing three 96 MP documents the
  drawing benchmark is within 20 % of the fresh instance, and the GPU process is back
  within 300 MB of its baseline after a forced collection.
- **Gates at the end**: `composite_test.py` (pixels must not move), `film_test.py`,
  `commands_test.py`, `perf_test.py` (2048x1152, 6000x4000, 12000x8000) and
  `perf_test.py --chain 6000x4000` (no regression), `smoke_test.py --no-helpers`, and
  the new `mem_test.py` against the targets above.

## 1. What the code says (hypotheses, ranked)

Read this before step 1 so the instrumentation measures the right things. None of it is
confirmed; step 1 confirms or discards each line.

**H1 — canvas churn on the hot path.** Every GL filter call allocates a fresh output
canvas: `renderTiled` (`inpaint_filters_gl.js:142`, `makeCanvas(W, H)`) and
`surfaceToCanvas` (`:471`). `filteredCanvas` (`inpaint_canvas.js:5145`) keys its view
cache on `vp.x, vp.y` (line 5147), so **every pan frame with a filter layer makes a new
2–8 MP canvas** and drops the old one; `layerMatchedPixels` (`:7215`) does the same per
match tick through `matchCanvas` → `applyMatchGL` (`inpaint_filters.js:266`); `matchStats`
(`:7237`) makes three small canvases per miss. Chromium backs large 2D canvases with GPU
memory (shared images in the GPU process) that is released only when the element is
collected, and V8 does not feel that pressure because the bytes are not on its heap. So a
session of panning accumulates gigabytes of dead canvases in the GPU process. Chromium
also stops accelerating new canvases once its per-page budget is exhausted; an
unaccelerated canvas uploaded with `texImage2D` (`bindSource`, `:401`) is a CPU readback
plus upload — which is exactly the shape of "levels 0.8 → 12 ms": the cost grows with the
input size, not with the pass count.

**H2 — a closed document releases its GPU resources late.** `destroy()`
(`inpaint_canvas.js:8182`) disposes the compositor's textures but never loses its WebGL2
context, and zeroes nothing: layer canvases and masks, `_baseCanvas`, `flatCanvas`,
`viewCanvas`, `sceneCanvas`, `matchBackdrop`, the pyramid levels (a `WeakMap`, line 1021,
so unreachable but uncollected), `_fcache*`, `_mcache*`, `_masked`, the undo snapshots'
canvases (`snapshotRect`, `:4742`) and the `kind: "canvas"` snapshots that hold whole old
layer stacks by reference (`:4800`, uncounted in `undoBytes`). A 96 MP document is roughly
2 GB of canvas backing store, all of it waiting for a major GC whose trigger does not see
GPU bytes. Four such documents match the reported session.

**H3 — the compositor's texture cache is capped by count** (`TEXTURE_CACHE = 48`,
`inpaint_compositor.js:131`), not bytes; a level-0 texture of a 96 MP source is 384 MB.
`forget(source)` (`:213`) is never called: when `displaySource` (`:6899`) replaces a
pyramid entry, the old level canvases stay as strong Map keys in `textures` until the LRU
reaches 48. Within a living document this is the leak the plan describes.

**H4 — the filter chain's surface pool.** `POOL_BUDGET` 320 MB fixed
(`inpaint_filters_gl.js:281`); after a context loss the foreign-generation surfaces stay
in `POOL` and in `poolBytes` until popped (`acquireSurface`, `:343`); a scope holds every
surface it acquired until `endScope`. Secondary — it makes the chain slow, it does not
grow the process.

**H5 — the shared GL canvas is resized per call** (`renderTiled:141`, `readSurface:445`):
a screen pass after a full-resolution export reallocates the drawing buffer each time
(capped at 33 MP, 132 MB, double-buffered). A per-switch cost, not a leak. Measure only.

**H6 — WebGL context count.** One context per editor's compositor (`compositor()`,
`:6966`), one probe in `GLCompositor.available()` (lost at once), one shared `G` in the
filter module. Chromium loses the oldest context above 16 per page; a closed editor's
context is only lost when its canvas is collected (H2). If the shared `G` is the oldest,
`G.lost` → `context()` builds a new one (`gen++`), which is handled, but the pool
bookkeeping goes stale (H4). Cheap to prevent: `loseContext()` in `dispose()`.

## 2. Step 1: instrumentation

### 1a. IPC `app:metrics` (main + preload)

`electron/main/main.js`, next to `app:info` (line 399):

```js
ipcMain.handle("app:metrics", () => ({
    processes: app.getAppMetrics().map((p) => ({
        pid: p.pid, type: p.type, name: p.name || p.serviceName || "",
        workingSetKB: p.memory.workingSetSize, peakWorkingSetKB: p.memory.peakWorkingSetSize,
        privateKB: p.memory.privateBytes,      // Windows only; undefined elsewhere
    })),
}));
```

`electron/preload.js` under `scumble`:

```js
metrics: async () => ({
    ...(await ipcRenderer.invoke("app:metrics")),
    renderer: {
        process: await process.getProcessMemoryInfo(),   // { residentSet, private, shared } in KB
        blink: process.getBlinkMemoryInfo(),             // { allocated, total } in KB
        heap: process.getHeapStatistics(),
        resources: webFrame.getResourceUsage(),          // images / other: { count, size, liveSize }
    },
}),
```

The preload is sandboxed (`main.js:145`); Electron 44 exposes these `process` methods
and `webFrame` in a sandboxed preload, but check each one once in the dev instance and
drop any that throws rather than guarding it forever. The GPU process is the row with
`type === "GPU"`; report its `privateKB` (falls back to `workingSetKB`).

### 1b. Forced collection and heap numbers: from the test, through CDP

No app change: `tools/cdp.py`'s `Cdp.call()` sends raw CDP. Use
`HeapProfiler.collectGarbage` (call it twice, then wait 500 ms: the canvas resources are
released after the element is collected, asynchronously in the GPU process; read the
metrics twice, 1 s apart, and keep the second) and `Performance.getMetrics` for
`JSHeapUsedSize`, `Documents`, `Nodes`, `JSEventListeners`. **Do not use
`performance.measureUserAgentSpecificMemory()`**: it needs cross-origin isolation, which
`scumble://` does not have, so it has been silently null all along (`perf_test.py:235`
never printed a renderer line).

### 1c. A canvas census (test-side, no app change)

In `mem_test.py`'s SETUP, before anything is built, wrap `document.createElement` so that
every canvas it returns gets a `WeakRef` in `window.__canvases` and is registered with a
`FinalizationRegistry` that counts collections. Both `makeCanvas` helpers
(`inpaint_canvas.js:264`, `inpaint_filters_gl.js:495`) go through `createElement`, so the
census sees everything the editor allocates. After a forced collection report: live
canvases (count, total bytes as `w * h * 4`), collected since the last report, and the
ten largest live ones with their sizes. A canvas with `width === 0` counts as released.

### 1d. The editor's own accounting: `ed.memoryReport()` (node repo)

A method on `InpaintEditor`, near `destroy()`, that returns plain data:

- `layers`: count and bytes of `canvas` + `mask` + `_masked` per layer, and whether
  `_fcache`, `_fcacheView`, `_mcache`, `_mcacheView` hold a canvas and its bytes;
- `pyramid`: for every known source (`_baseCanvas`, every layer's canvas / mask /
  `_masked` / cache canvases, `selection`): the entry from `this.pyramids` (a WeakMap
  cannot be enumerated, so walk the known sources), level count and bytes;
- `undo`: `undoBytes`, steps per kind, and the bytes of every canvas reachable from
  `undo` / `redo` (rect copies and the `kind: "canvas"` / `"layers"` snapshots' layer
  canvases, deduplicated against the live layers) — this shows whether H2's uncounted
  snapshots matter;
- `compositor`: `GLCompositor.stats()` (new: entries, bytes as `w * h * 4`, target bytes);
- `chain`: `glChainStats()` plus a pool census export from the filter module
  (`glPoolStats()`: surfaces per size, bytes, foreign-generation count);
- `objects`: bytes of `this.objects.ids`;
- `scratch`: `sceneCanvas`, `viewCanvas`, `matchBackdrop`, `flatCanvas`, `strokePreview`,
  `maskedPreview`, `antsCanvas` sizes.

### 1e. The benchmark inside the test

Three numbers, the same on every round, taken with the film look document of
`perf_test.py` (copy its BENCH builder into `mem_test.py`: base + three paint layers +
result with match + `film.look`, at 12000x8000):

- `pan`: 30 pointermove frames, median ms (as in `perf_test.py`);
- `levels`: a `levels` filter layer added on top, 7 slider ticks, median ms — the
  symptom's own number;
- `upload`: a probe with its own tiny WebGL2 context: paint a fresh 2048x2048 canvas,
  `texImage2D` it, `gl.finish()`, ms. If canvases have gone unaccelerated (H1), this
  jumps from well under a millisecond to tens.

### 1f. The session walk (`tools/mem_test.py`)

```
python tools/mem_test.py                 # 12000x8000, four rounds
python tools/mem_test.py 6000x4000 --rounds 3
python tools/mem_test.py --keep          # variant B: the tabs stay open
```

Per round: build → bench → report; close → report; forced GC → report; then the three
questions from the plan as columns: does the number come back **after closing**, after
a **forced collection**, after **Free VRAM** (`ed.freeHelperModels()`, which is a no-op
for GPU memory today — after step 3 it is the escape hatch, so the column is there from
the start). Variant B keeps the tabs open for four rounds, then closes all and repeats
the close / GC / free columns once. Print one table: round, phase, renderer private MB,
GPU private MB, live canvases (n / MB), compositor MB, pool MB, undo MB, pan ms,
levels ms, upload ms. Also print every console line that contains `WebGL` or `context`
(the `window.__log` hook from `cdp.py`) so a context loss shows up.

**Exit of step 1**: the table reproduces the degradation, or it does not. If it does not
with synthetic canvases, repeat with a real 12k PNG through `load_image` (the `<img>`
decode and `_baseCanvas` path, `baseSource()` at `:6926`) before concluding anything.
Write the numbers into `docs/PERFORMANCE.md` phase 6 before starting step 2, and tick
the hypotheses in §1 above.

## 3. Step 2: fixes, each measured with `mem_test.py` before the next

Order is by expected effect and by risk. Stop after the targets hold; the rest stays in
the phase 6 section as "not needed".

### 2a. Release canvas backing stores explicitly (node repo, `inpaint_canvas.js`)

Chromium frees a canvas's pixels at once when `canvas.width = canvas.height = 0`, and
the compositor's texture goes with `forget()`. One helper on the editor does both:

```js
/** Drop a canvas the editor owns exclusively: its texture, then its pixels. */
dropCanvas(c) {
    if (!c || !(c instanceof HTMLCanvasElement) || c.width === 0) return;
    const entry = this.pyramids.get(c);
    if (entry) for (const lvl of entry.levels) if (lvl) this.dropCanvas(lvl);
    if (this._compositor) this._compositor.forget(c);
    c.width = c.height = 0;
}
```

**Ownership is the whole difficulty.** A zeroed canvas that is drawn later throws
`InvalidStateError` and kills the frame, so only canvases nobody else references may
go through `dropCanvas`. The rule, to be written into the node's `DEVELOPMENT.md` as
§21f: *a cache slot owns its canvas only when the canvas is not also the slot's input*.
Concretely:

- `displaySource` (`:6899`): when an entry is replaced (version, size), drop the old
  entry's levels first — they are exclusively owned (only the pyramid and the texture
  cache ever see them).
- `filteredCanvas` (`:5145`): the cached canvas is owned when it is not `below` / `input`
  (a filter that did nothing hands its input back, line 5176). Store `owned: canvas !==
  below && canvas !== input` in the slot and drop the old slot's canvas when the slot is
  replaced or invalidated (`:5078`, `:4834`, and wherever `_fcache = null` is written).
- `layerMatchedPixels` (`:7215`): owned when `out !== out0`. Same handling in
  `markMatchChanged` (`:7201`).
- `releaseSnapshot` (`:4781`): `snap.canvas` from `snapshotRect` is a copy — drop it
  instead of nulling it.
- `sceneCanvas`, `viewCanvas`, `matchBackdrop`, `flatCanvas`, `strokePreview`,
  `maskedPreview`, `antsCanvas`, `clipScratch`: drop the old one wherever it is replaced
  because of a size change (`:7454`, `:7075`, `:7044`, `:7130`, `:4098`, `:2537`, ...).
- `removeLayer` (`:6221`) and `mergeDown`: **not** here — the `kind: "layers"` undo step
  still references the layer's canvas. Layer canvases are released only when the undo
  step that holds them is released (extend `releaseSnapshot` for `layers` / `canvas`
  snapshots: drop a canvas that no live layer and no other snapshot references; a small
  reference count over `undo` + `redo` + `layers` computed at release time is enough) —
  do this only if step 1 shows undo-held layer canvases as a real share.
- `destroy()` (`:8182`): after `close()` has fired `syncLayers()` (`:7346`, it uploads
  dirty layers asynchronously through `uploadCanvas`, and `close()` does not await it),
  drop **everything**: every layer canvas / mask / `_masked` / caches, `_baseCanvas`,
  `selection`, `objects = null`, both undo lists, the scratch canvases, and lose the
  compositor's context (`gl.getExtension("WEBGL_lose_context").loseContext()` inside
  `dispose()`). Make `close()` keep the sync promise in `this._closingSync` and have
  `destroy()` do the dropping in its `finally`. Also `host.emit("removed", {editor})`
  hands the editor to plugins; document that the editor is dead after that event.
- `strokePreview` / `_livePreview` canvases and the worker: `encodeCanvas` reads pixels
  synchronously into an ImageData before posting to the worker (check
  `inpaint_canvas.js` around `encodeCanvas` / `snapUrl`, `:4732`) — confirm, or the
  drop in `releaseSnapshot` races the encode.

Measure after 2a: the census's live-canvas bytes after close + GC should be near zero
for the closed document, and the GPU private bytes should follow within a second.

### 2b. Reuse instead of reallocate on the hot path (app GL module + node editor)

The film stack's per-frame canvases (H1) disappear when the readback draws into the
canvas that is already there:

- `inpaint_filters_gl.js`: `surfaceToCanvas(s, into)` and `renderTiled(..., into)` take
  an optional destination canvas of the same size (`into.width === W && into.height ===
  H`), drawn with `globalCompositeOperation = "copy"`; thread it as `info.into` through
  `applyFilterGL` (`:939`), `runShader` (`:921`) and `applyMatchGL` (`:967`), and through
  `applyFilter` in `inpaint_filters.js` (it only passes `info` on).
- `filteredCanvas`: pass `into: (old slot canvas, if owned and same size)`; then a pan
  with a filter layer creates no canvas (the census is the check: 60 pan frames, zero
  new canvases).
- `layerMatchedPixels`: the same with the old `_mcacheView` canvas.
- `matchStats`: keep three small canvases on the editor (`_statsScratch`) instead of
  three per miss — tiny, but it is the same disease.

Do not touch the cache keys: `vp.x, vp.y` is needed because the grain field is anchored
at the image origin.

### 2c. The compositor: a byte budget, and `forget` actually called (node repo)

`inpaint_compositor.js`: replace `TEXTURE_CACHE = 48` with `TEXTURE_BUDGET` in bytes
(start at 1 GB on desktop; `stats()` reports it), track `bytes` per entry and in total,
and let `_evict()` drop LRU entries until the total fits, never one used in the current
frame. `forget()` gets called from `dropCanvas` (2a). Add `clear()` (drop every texture,
keep the context) for step 3 and `stats()` for step 1. The compositor's own targets are
two viewport-sized textures — fine.

### 2d. The pool: a policy instead of a fixed budget (app GL module)

- On a context change (`context()` builds a new `G`): purge `POOL` of foreign-generation
  surfaces and recompute `poolBytes`.
- Track the peak number of surfaces alive at once per size (`inFlight` per key, updated
  in `acquireSurface` / `releaseSurface`); `trimPool` keeps that many per size and
  drops the rest by age (an `idle` counter bumped in `endScope`), and drops everything
  above `POOL_BUDGET` as today. Export `glPoolStats()` and `glReleasePool()` (step 3).
- Only then: re-measure the crossover (`perf_test.py --chain 6000x4000` and the full
  resolution figure from phase 5 step 2's method) and raise `CHAIN_MAX_PIXELS` if the
  numbers say so. Fewer surfaces per chain (the halation's two-pass hold) is **not** in
  this phase unless that measurement says the pool is the limit.

### 2e. Only if step 1 points there

- `objects.ids` at image size: the node path (`applySegmentIds`, `:4525`) accepts
  `w === this.width`; a 96 MP id map is 192 MB. Bound to ≤ 2048 px on the long side
  and scale on use (the in-app SAM2 path already does).
- Undo-held layer canvases (see 2a, `removeLayer`) and undo as dirty-rect tiles.
- Layers evicted to the mirror.

## 4. Step 3: the escape hatch

- `ed.releaseCaches({ deep })` (node repo): drop `_fcache*`, `_mcache*`, `_masked`,
  `sceneCanvas`, `viewCanvas`, `matchBackdrop`, `flatCanvas`, the pyramids of every
  source (`dropCanvas` on the levels only, the sources stay), `compositor.clear()`;
  `deep` also calls `glReleasePool()`. Returns the bytes it freed (from the sizes it
  dropped). The next draw rebuilds what it needs; the pyramid rebuilds one level per
  frame by design (`_pyramidBudget`).
- The **Free VRAM** button (`:1659`, `freeHelperModels`) also calls `releaseCaches({deep:
  true})` on every editor that is not the active tab and a shallow one on the active tab,
  and the status line says "Freed N MB of caches" next to the helper message.
- Automatic: `renderer/shell.js` polls `window.scumble.metrics()` every 30 s while idle
  (no pointer down, no pending run, no provider run) and calls `releaseCaches` on the
  inactive tabs when the GPU process's private bytes exceed `settings.memory.gpuLimitMB`
  (default 3072, a row in Settings › Local files or a new Memory row; 0 = off). Log one
  line per trigger to the console with the before / after numbers.
- `commands.js`: `status` gains `memory: { gpuMB, rendererMB }` from the same IPC, so an
  MCP client can see it; no new command.

## 5. Step 4: gates, docs, release

1. Gates from §0 on a fresh instance each; `mem_test.py` last, with the table pasted
   into `docs/PERFORMANCE.md` phase 6 ("done") next to the step-1 table.
2. Node repo: `DEVELOPMENT.md` §21f (canvas ownership and `dropCanvas`, the compositor
   budget, `releaseCaches`); commit as DenRakEiw; then `python tools/sync_editor.py`
   and check the round trip.
3. App: `docs/PERFORMANCE.md` phase 6 section rewritten as "done" with the numbers and
   the hypotheses ticked; `CLAUDE.md` "Where things stand" hand-over; `CHANGELOG.md`
   section **0.1.4** (phase 6 and phase 5 step 2 together, as decided with the user on
   2026-09-10); `package.json` 0.1.4; commit, tag `v0.1.4`, push, publish the draft
   (`gh release edit v0.1.4 --draft=false`).
4. `tools/mem_test.py` documented in `docs/PERFORMANCE.md` §7 and in `CLAUDE.md`'s test
   list.

## 6. Traps the implementer should know

- A zeroed canvas throws on `drawImage` / `getContext().getImageData`. If a frame dies
  after 2a, the census's "ten largest live" list and a `try` around the draw with the
  canvas's size in the message find the owner quickly. `composite_test.py` and
  `commands_test.py` exercise most paths; run them after every ownership change.
- `close()` fires `syncLayers()` without awaiting it; `destroy()` must not drop the layer
  canvases before that upload has read them.
- Scripted waits use `setTimeout`, never `requestAnimationFrame` (rAF does not fire in a
  hidden window). The census hook must be installed before the document is built.
- `HeapProfiler.collectGarbage` collects the JS side; the GPU-side release of a collected
  canvas is asynchronous. Read the metrics twice, 1 s apart.
- A `WeakMap` (the pyramids) keeps its values alive exactly as long as its keys; the
  levels of a dropped source are unreachable but not collected. That is why `dropCanvas`
  walks the levels itself.
- The compositor's `textures` is a strong `Map`: a source that is only forgotten by the
  editor stays alive through it until `forget()` or eviction. Zeroing the canvas
  without `forget()` frees the pixels but not the texture, and the entry then holds a
  0x0 canvas as its key.
- Restart the app between measurement runs. The whole phase exists because the numbers
  drift.
