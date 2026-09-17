# Bug list

Reported and not yet fixed. One section per bug: what was seen, what is already known
about it, and what has to be measured before anyone writes code. A bug leaves this file
when it is fixed (with the release it went out in) or when it turns out not to be one.

Fixed bugs are not kept here - `CHANGELOG.md` has them per release, `docs/PERFORMANCE.md`
the ones that were performance work.

---

## Fixed, waiting for its release

An entry here leaves the file when the release named in it is published.

Nothing at the moment.

---

## Open

### What phase N1 found on the way

**Written** 2026-09-17 with the measurement of phase N (`docs/PERFORMANCE.md` §14, `tools/native_test.py`,
`tools/native_limits.py`). Seen while measuring, not reports; none is fixed.

- **A provider run's crop still blocks the window for 0.6 s** (2.5 s before B item 4, `docs/PLAN_BCE.md` §3b "B item 4
  as built"): a 1,024 px selection, a 1,492 px patch, the mask kernels 0.2 s, per-pixel JS in `stitch.js` 0.2 s, Canvas 2D
  0.26 s, all on the main thread in one piece. `native_test.py provider_crop` is the row. The number to beat: under
  0.2 s, or no block at all (the stitch in a worker).
- **The whole-picture wand on a document above the canvas limit works for 4.6 s and then refuses** ("larger than any
  canvas", 30000 × 20000, `native_test.py 30000x20000 wand_whole_picture`). Why it gets
  that far before it refuses is not read yet. Either it says so at once, or it floods over tiles.
- **At the renderer's 15.5 GB of typed arrays the editor throws instead of saying no**: the 19th full 15k layer ends in an
  uncaught `RangeError: Array buffer allocation failed` out of `allocTileBytes` / `TileLayerPixels.writable`
  (`native_limits.py layers 15000x10000 22`). The arena counts a refused chunk and then falls back to a plain array, which
  fails the same way. Not measured: what a stroke or a paste does to the document when it hits that in the middle.
- **Opening a 150 MP PNG blocks the window for 2.1 s**: the picture is decoded into an image and read in 13
  `getImageData` calls of 44 MB (1.7 of the 3.2 s). The stream reader a 600 MP file goes through never blocks longer
  than 0.16 s, but inflates in JS at half the decoder's speed.

### What phase E left open on large documents

**Written** 2026-09-17 with phase E (`docs/PLAN_BCE.md` §3, the "as built" blocks). Not reports: gates of the plan that were
measured and not met, and what still needs a canvas of the picture. Each has a number to beat.

- **An export in bands is slower in wall time than the whole flatten was, while the window stays usable.** 15000 × 10000,
  three full paint layers and a levels layer: 6.2 s in bands (longest block 0.7 s, the first band) against 3.4 s through
  one canvas (2.4 s blocked in one piece). With the film look on top 9.5 s against 8.2 s. The time is the region pass at
  full resolution: about 130 ms a band, most of it `putImageData` of every layer's tiles into a region canvas
  (`tools/export_test.py --perf 15000x10000`). The plan's gate was 3 s and 50 ms. The way down is the one the plan had:
  composite plain stacks in the pool's workers from the arena (`composite_tile`), and keep the region pass for bands
  with a filter, a colour match or a blend mode.
- **The film look's halation on a document above the canvas limit is very slow to export**: 67 s for 20000 × 14000 with
  blocks of 7.6 s a band, 146 s with blocks of 16 s at 30000 × 20000. Its blur is 1.2 % of the long side (240 px there), so a band carries 725 rows of margin on
  either side and the pass is 60 MP, above what the WebGL filters render in one piece.
- **Inverting the selection of a very large document blocks the window**: 0.5 s, and 1.2 s back, at 30000 × 20000, and
  the inverted mask is 2.4 GB of tiles (masks are RGBA tiles; one-channel masks were C5's plan and are not built).
- **The mip refresh after a whole change still blocks 45 to 90 ms** at 15k (the gate was 5 ms): the frame the landings
  cause builds the atlas slots on the main thread (`docs/PLAN_BCE.md` §3 "E1 as built").
- **Above 268 MP only the full-size PNG, PSD and ORA are written.** JPEG, WebP, the Size row and the frame need one canvas
  and are refused with a message; so are the canvas-sized edits (resize, extend, crop to selection, merge into the base
  through a canvas) wherever they still build a canvas of the picture. A PSD stops at 30,000 px a side and 4 GB a section
  (a 30000 × 20000 document with one paint layer was 3.7 GB), an ORA at 4 GB (no zip64).
- **A colour-matched layer keeps the whole flatten for exports up to 268 MP** (the user's open decision (b) of C6 (c) 7c);
  above it the bands use the statistics the screen uses, the only ones there are.
- **Seen once, not reproduced**: `editor_test.py` `a_settled_read_builds_its_levels_in_the_worker_not_here` failed with
  `requested: 0` in one of some twenty runs since the mip chains go through the pool.

### A headless MCP instance keeps Scumble from starting

**Reported** 2026-09-16 ("wieso kann ich die app nicht starten?"), during a Claude Code session in `F:\canvas`.

**Seen:** starting Scumble showed no window at all. Two processes were running, both started by that session's MCP
registration (`.mcp.json`: `electron.exe electron/main/mcp/launch.js --mcp`, i.e. the dev app from `F:\canvas`):
the launcher and `electron.exe F:\canvas --mcp`. No Scumble was running when the session began, so the MCP server had
started the app **headless** (`AgentBackend` in `electron/main/main.js`), on the default profile `%APPDATA%\Scumble`.
It held that profile's single-instance lock since the start of the session. After both were stopped, the packaged app
started normally.

**Known:** both instances use the same `userData`, so a second start is meant to hand over to the running one:
`app.on("second-instance", () => showWindow())` (`main.js` 573 for the headless agent path, 626 for the normal start),
and `showWindow()` creates the window or restores a hidden one. `docs/MCP.md` and CLAUDE.md say "a second start of
Scumble shows it". Here nothing appeared.

**Not known, to measure first:**
- Which binary the user started (the installed 0.1.14 in `%LOCALAPPDATA%\Programs`, or `dist\win-unpacked\Scumble.exe`),
  and whether a second start of the **same** build as the headless one shows the window (dev headless + dev start,
  exe headless + exe start). A dev and a packaged Electron may not share the lock or the hand-over.
- Whether `second-instance` fires in the headless instance at all (log it), and whether `showWindow()` then creates a
  window that stays hidden or off screen.
- Whether the headless instance's renderer was ready (`bridge` ready) when the second start arrived.

**Workaround:** start Scumble before Claude Code, so the MCP server drives the visible window; or stop the leftover
`electron.exe ... --mcp` processes. A fix belongs in the hand-over (the running headless instance shows its window on a
second start of any build), with a gate step in `tools/mcp_test.py`: start headless through the launcher, start the
app a second time, assert a visible window within a few seconds.

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

### Selection undo and bounds lose isolated pixels above 1 MP (canvas backend)

**Found** 2026-09-14 by C2's final review (`docs/PLAN_BCE.md` §C2), present since phase A (0.1.10):
on the canvas backend, which is what the packaged app ran until 0.1.13 and still runs with Settings ›
Rendering › Tile engine switched off, a selection above 1 MP takes its extent
from the selection's 1/16 display level (`selectionExtent()` in `inpaint_canvas.js`). Four smoothed
halvings round an isolated pixel away (below about alpha 128 always, and at sizes that do not halve
evenly even alpha 255), so the selection's undo step does not copy it and its bounds scan does not
look for it. Measured: 2401 × 1601, a 400 × 300 rectangle plus 24 isolated pixels of alpha 120 or
255: the extent [270, 270, 2307, 1523] misses the opaque one at (1447, 1525), `getBounds()` comes back
as [300, 300, 2280, 1491] against the exact [300, 300, 2280, 1526] (a run's crop and the ants box leave
selected pixels out), and a `select_rect` elsewhere followed by an undo restores the selection without
that pixel. 3000 × 2000 loses two alpha-120
pixels the same way; 2048 × 1536 nothing. A wand's or a matte's speckle is where it shows.

**Not fixed, on purpose**: an extent that cannot drop a pixel needs a full-resolution readback of the
selection on this backend (seconds at 15k, the cost phase A took out), or a max-pooling level the 2D
canvas cannot build. The selection drag, which lost the same pixels, takes the whole image instead
since C2 (b)'s review. On tiles the extent is the tile set's exact bounds and nothing is lost; C5 makes
the selection mask tiles and C7 retires the canvas backend, which closes this.

### A very large PNG stays jerky to work on

**Reported** 2026-09-11 by DenRakEiw, on a PNG about 15,000 px on its long side. Panning
and painting stutter badly.

**The file format is ruled out.** The user saved the same picture as JPEG and it is not
smoother (2026-09-11), which is what the pipeline predicts: after decoding, base and layers
are RGBA canvases and the format cannot matter. So the heading is misleading and the bug is
about the *size*. It is the untiled full-resolution layers that are the suspect.

**Update 2026-09-15, for 0.1.13: the tile engine is on by default.** Most of what follows describes
the state before it (untiled layers, "layer tiles were deliberately not built"); it stays as the
record. Layers, masks and the selection are tiles now (`docs/PLAN_BCE.md` C2 to C6), and 0.1.13 runs
them in the installed app unless *Settings › Rendering › Tile engine* is unticked (or `--no-tiles`).
Measured on a 15000 × 10000 document with three full-size paint layers, a colour-matched result, a
film look and a levels layer (`mem_test.py`, one document open; `PLAN_BCE.md` §C7 "The default, as
built"): about 4.5 GB in the renderer and 1.6-2.3 GB in the GPU process on tiles, against 0.7 GB and
7.2-7.8 GB with the tile engine off. The entry stays open until the user reports on their own 15k
file. What to ask for: the file's size and layer count, whether panning and painting still stutter
with the tile engine on, the same with it off (after *Restart now*), and the card's and the GPU
process's numbers from Settings › Rendering while it stutters. What is known to be still slow on
tiles is the "Still slow" list under 0.1.13 in `CHANGELOG.md` (smudge, the whole-picture wand,
invert, the whole flatten behind renders and exports); with two 15k documents open at once a levels
tick took 49-58 ms on tiles and with three the pan took 65 ms, not broken down yet.

**Update 2026-09-16, after C4, C6 (c) 7b to 7d and C6 (d) (0.1.16, unreleased).** The numbers on the synthetic 15k
document are in `docs/PERFORMANCE.md` §11: pan 2.6 ms (0.2 ms on the GPU stack), a brush dab and its frame 1.2 ms, undo of a
stroke 26 ms, the first frame at 1:1 1.2 ms; a colour-matched full-size layer no longer makes 1.1 GB of copies, and a crop,
flatten or undo of them no longer decodes the picture again. Still whole-picture and slow: invert (0.9 s), the band wand
(1.8 s), a film point under a film look (2.2 s), renders and exports. The entry stays open until the user reports on
their own 15k file (what to ask for: the 2026-09-15 update above).

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

**Phase A of `docs/PLAN_TILES.md` is built (2026-09-13)** and takes the discrete hitches out
of the table above: selection change 6 ms, bounds 6 ms warm, stroke undo 42 ms (the film
look's re-render; about 10 without a filter layer), grow / shrink / invert 112 / 131 / 54 ms,
the bucket and the wand on a bounded region a fraction of before, a stroke's buffers 19 MB
instead of 1.8 GB and the live preview refreshed inside the dab, the compositor's textures a
window of each source. `docs/PERFORMANCE.md` §9 has the table. What it does **not** change
is the memory per document (2.3 GB of layers, 0.95 GB of pyramids, 0.57 GB base, 0.57 GB
selection canvas in the GPU process for this document), and the ops that read the whole
selection keep their phase 4 cost. Whether the stutter the user sees is that memory is still
the open question 3 above; the memory watch now reads the card as a whole (Settings ›
Rendering shows it), which is the number to look at while it stutters.

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
