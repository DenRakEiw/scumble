<!-- U0 of docs/PLAN_WASM_BUILD.md §7 ("The user's answers after K4", item 55), written 2026-11-07 from the U0 numbers;
U1 and U2 build from it. Line numbers are from `8689d49` on `wasm-kernels`; grep the name before editing. Every effort
figure is inferred. -->

# The ONNX helpers off the main process: U0's numbers, U1's design, U2's candidates

The user, 2026-11-07: "höchste prio sam (das ist echt lahm)". SAM2, the matting models and Depth Anything run their
`InferenceSession.create` and `run` on Electron's main process (`docs/HELPERS.md` "Every model but LaMa runs on the main
process's thread"); LaMa runs in a utility process of its own (`electron/main/onnx/lama.js`, `lama_process.js`). U0
measured where the time goes before U1 moves them. **Nothing in the app changed for U0**: the harness installs its
timers through the main process's inspector.

**In one paragraph:** a warm SAM2 click is fast (7-8 ms); what is slow is **the object map** the hover tool needs
(about 1.9 s on every picture change, a third of it JavaScript), **the cold start** in front of it (about 1.1 s of
session loads, paid again after every Free VRAM and so after every local ComfyUI run), and on a 15k picture **the
window's own object shapes** (0.3 s per hovered object, 1.3-2 s per click, about 0.5 GB of GPU-process memory per kept
shape). While a model runs, **main stops** (1.1 s in one piece at the first call, about 0.2 s sixteen times during a
map, 4.8 s for a CPU cutout), and with it every IPC channel. In a utility process main never blocked (U0's probe), so
U1 fixes the freezes; the waits need U2.

## 0. How it was measured

`tools/helpers_perf.py` (the harness) and `tools/helpers_process_probe.js` (the engine in a utility process);
`docs/measurements/u0_2026-11-07/` (`summary.txt` with the medians and spreads, `raw/*.json` every rep with main's
events, `chain.log`). The machine: the user's RTX 5090 (32 GB), 24 logical cores, onnxruntime-node 1.29.0, Electron
44.2.0; the user's ComfyUI running beside it (the card at 3-9 GB used between batches, `card` in the summary), other
agents' gates kept out by the busy lock and waited for before each batch.

- **A fresh instance per batch** (`--no-comfy`, its own profile, the window brought to the front before every row), the
  helpers folder the user's ComfyUI `models/` (SAM2 tiny and base+, BiRefNet lite, RMBG-1.4 in `onnx/`), the app
  folder's SAM2 small, RMBG-2.0 and Depth Anything V2 Small linked as a scan links them; read only, nothing downloaded.
  **Three runs** of every batch (`hovermem` four: the fourth adds readings 20 and 60 s later). The `gpu` batch's run 1
  came from a first chain, stopped after it and restarted with `--skip 1:gpu` to add the lock's gap and `batchsize`.
- **The picture:** the tutorial's scene (`docs/images/tutorial/scene.jpg`, 2000 x 1125: a person on a car, a bag, a
  building; untracked material) through `host.objectInput` to the 1024² input the app sends: 95 objects from 837
  candidates. `dist/daily`'s `adobe_*.jpg` are gradients (two objects) and were not used. The editor batches take the
  scene scaled to 6000 x 3375 and 15000 x 8438 (Lanczos).
- **Each row:** the renderer's wall (the `await` of `host.helperCall`, as the app calls it); **main's longest block**
  (an interval timer in main every 4 ms, a gap over 20 ms counted as a block; `monitorEventLoopDelay` beside it); the
  longest IPC round trip of a probe the renderer sends every 3 ms during the call (`app:tileMode`); main's breakdown from
  wrappers around `InferenceSession.create` / `run` / `release`, `Sam2.encode` / `automask` / `predict` and the IPC
  handlers. Memory after a forced GC: main's private bytes (`app.getAppMetrics`), the WDDM counters of main's pid (GPU
  dedicated), the card by `nvidia-smi`.
- **Batches:** `gpu` (Settings › Helpers device GPU: everything on DirectML, a matting session released after each run,
  `matting.js:43-44`), `cpu`, `editor` (device auto: the object tool's own path on the two large documents), `probe`
  (the same modules in a utility process forked from main), `batchsize` (the decoder's batch sizes, each in a fresh
  process), `hovermem` (the hover's object shapes at 15k and what they hold).

## 1. The numbers

Median [min-max] over the three runs (a row with several reps: every rep of every run), in ms unless named.

### 1.1 SAM2 (base+, the user's pick; the scene's 1024² input)

| Call | DirectML wall | Main's longest block | Where the time goes |
|---|---|---|---|
| **The first SAM2 call of an instance** (a point: both sessions, the encode, one decode) | **1,575** [1,484-1,783] | **1,077** [992-1,212], one piece | the two sessions 1,227 (the encoder about 1.0-1.2 s, the decoder 0.21 s), the encode 65, the first decode at B 1 265 (DirectML plans each new input shape once) |
| A point, warm (a click where the map has nothing, `select_point`) | **8** [7-14] | 0 | one decode, 6.5 |
| **The object map on a cached embedding** (the hover tool's map) | **1,928** [1,748-2,065] | 218 [197-246], in about 16 pieces | 16 decoder batches of 64 points 1,287 [1,103-1,386] (about 78 each, the first 160), then **JavaScript 627** [577-656]: the stability filter and Int8 copy 33 per batch, NMS and the label paint 95 |
| The object map on a new picture | **1,916** [1,820-1,950] | 208 [203-208] | the encode 37 + the map |
| A point after a map | 7 [7-10] | 0 | |
| Free VRAM (`helpers:free`) | 310 [271-371] | 310, one piece | releasing the two sessions |
| **The object map after Free VRAM** (the first hover after a local ComfyUI run) | **2,786** [2,717-3,108] | 999 [939-1,170] | the sessions again 1,107 + the encode + the map |
| SAM2 tiny / small: the first call | 1,146 / 1,251 | 668 / 771 | a smaller encoder session (0.83 / 0.94 s with the decoder) |
| SAM2 tiny / small: the object map | 1,876 / 1,947 | 238 / 362 | **one decoder file for all four sizes** (20.6 MB, `models.js:31-32`) |
| A 16 x 16 grid instead of 32 x 32 (4 batches; 47 objects instead of 95) | 544 [529-584] | 193 | |
| **The CPU** (device "cpu"): the first call / a point / the object map | 2,683 / 29 / **38,283** [37,910-39,097] | 2,099 / the whole point / **2,507 per batch** | the encode 2.1 s; 16 batches of about 2.35 s; the JavaScript the same 663 |

**The decoder's batch size cannot be tuned:** this export runs B 1 and B 64 only. 16, 32, 128 and 256 fail at once with
"Non-zero status code returned while running Mul node. Name:'/Mul_14'", on DirectML and on the CPU, in a fresh utility
process as well as after the app's sizes had run (`batchsize`: five sizes in three runs).

### 1.2 Matting and depth

| Call | Wall | Main's longest block | Where the time goes |
|---|---|---|---|
| BiRefNet lite, CPU (the "auto" device's choice, `matting.js:24-26`) | **4,778** [4,552-8,479] (the first with its 2.6 s load) | **4,785, the whole run** | one native run |
| BiRefNet lite, DirectML ("gpu": a load and a release every time) | 3,541 [2,783-5,596] | 2,764 [2,152-2,908] | the session 2,594, the run 388 [295-2,105], the release 362 |
| RMBG-1.4, CPU / DirectML | 596 / 832 | 601 / 445 | |
| RMBG-2.0, CPU (the full BiRefNet; not run on DirectML, B5's 24.7 GB) | 8,495 [8,166-18,020] (the first with its 6.2-6.6 s load) | 8,485 | |
| Depth Anything V2 Small at 924 x 518 (the standard map), DirectML / CPU | 240 / 798 | the whole run | the first call about 1.0 s (its load 0.5 s) |
| The same at 1568 x 882 (the large route, `DEPTH_LARGE`) | 766 / 3,921 | the whole run | a Fine map is 5 calls at the standard size, Finest 10 (`host.js:6778-6798`) |

### 1.3 Memory (main's private bytes after a forced GC; the GPU's dedicated bytes of main's pid)

| After | Main private | GPU dedicated |
|---|---|---|
| the start | 85 MB | 0 |
| SAM2 base+'s first call (DirectML) | **3.5 GB** | 3.0 GB |
| an object map | **6.2 GB** | **5.6 GB** |
| Free VRAM | 0.33 GB | 0 |
| SAM2 tiny / small after a map | 4.8 / 4.9 GB | 4.3 / 4.3 GB |
| depth on DirectML | 4.1 GB | 3.7 GB |
| three BiRefNet lite or RMBG-1.4 cutouts on "gpu" (each released) | 0.4 GB | 0 |
| SAM2 / BiRefNet lite / RMBG-2.0 / depth on the CPU | 0.46 / 0.40 / 1.15 / 0.21 GB | 0 |

`docs/BUGS.md`'s 6.1 GB ("a cold SAM2 select_point gave 6.1 GB on DirectML") is SAM2's DirectML allocations counted in
main's private bytes: 3.5 GB after the first call, 6.2 GB after a map, all of it back at Free VRAM. (The `gpu` batch's
own "after objects" row reads 8.6 GB / 8.0 GB: the failed batch sizes' allocations stay until the release.)

### 1.4 The object tool in the editor (device auto, the scene scaled)

| Step | 6000 x 3375 | 15000 x 8438 | Blocks |
|---|---|---|---|
| The first hover's map (`ensureObjects`; at 6k the instance's first SAM2 call, at 15k a new picture on warm sessions) | **3,082** [2,910-3,167] | **1,744** [1,744-1,856] | main 1,158 / 183; the window's nearest scale of the label map to the document 41 / **236** |
| The map again (the embedding cached) | 1,461 | 1,939 | the window's scale-back 38 / **527**; at 15k a 253 MB `Uint16Array` |
| The window's other parts | `objectInput` 3-5, the hash 2 | the same | |
| **A hover over a new object** (`objectShape`: a canvas of the whole document) | 46-53 | **278-328** | the window, one piece |
| **A click on an object** (the shape, then the selection's combine) | 199 [188-215] | **1,896** [1,258-2,015] | the window |
| `select_point` (the decode, then `selectLogits` in the workers) | 107 [54-316] | 103 [64-199] | main about 35 (the first after a map 240: a new shape) |
| **14 objects hovered at 15k** (`hovermem`, four runs: 13 shapes kept) | | the GPU process 0.41 -> **5.4-6.4 GB**; the window 1.17 -> 1.65 GB; 160-330 per shape | 3 s after the shapes were dropped (and a GC) the GPU process held 11.6-14.1 GB; 20 s after, 1.49 GB (run 4) |

The object map was faster in the editor than in the `gpu` batch (decode 818-995 against 1,287, on the same scene): the
editor's first decoder call is the map at B 64, the batch's first is a point at B 1. In the probe the order flipped
the same way (1.55-1.6 s in a dry run before the chain with the map first, not committed; 1.8 s in the chain with the
point first; `batchsize`'s B 64 maps after a point 1.76-1.78 s). Inferred, not isolated: the session runs B 64 faster
when B 64 was its first shape (U2 item 4).

### 1.5 The same engine in a utility process (`probe`)

| | DirectML | CPU |
|---|---|---|
| The process up (spawn 12, onnxruntime loaded in 10, the first answer) | 52 [52-53] | 50 |
| The first SAM2 call / a point / the object map | 1,624 / 7 / 1,815 | 2,662 / 29 / 38,408 |
| BiRefNet lite / depth 924 x 518 | 4,043 / 258 | 6,488 / 767 |
| **Main's longest block during any of it** | **0** | 35 [0-54] during the CPU map (24 ORT threads crowd main) |
| The renderer's IPC round trip at most | 14 (9 but one rep) | 29 |
| The message port there and back: 4 / 8 / 16 MB | 17 / 33 / 66 (main 26 for 16 MB) | |
| A "free" inside the process / `kill()` -> exit | 532 (the process keeps 0.36 GB) / **8.7** | 87 / 3.1 |
| Memory | the process 6.3 GB private and 5.6 GB GPU after SAM2, 7.0 / 6.4 GB with BiRefNet and depth; gone at the kill, the card back at once | 0.5-0.8 GB |
| The renderer -> main copy of a 4 MB picture (a refused `helpers:cutout`) | 9 [9-11] | |

The same answers as on main (95 objects from 837 candidates; the point's score to every digit), the same times within
the spread.

## 2. Where "slow" comes from

Three things add up, and only the first is what U1 is about:

1. **Main stops while a model runs.** Every `create`, `run` and `release` is a synchronous native call on main's thread
   (`onnxruntime-node/dist/backend.js` `run`: `setImmediate`, then the call). The first SAM2 call holds main for 1.1 s in
   one piece (the encoder's session), an object map for about two seconds in 16 pieces of 0.1-0.25 s, Free VRAM for
   0.3 s, a CPU cutout for its whole run (4.8 s, RMBG-2.0 8.5 s), a depth map for its whole run, SAM2 on the CPU 2.5 s
   per batch for 38 s. While main stops, everything that asks main waits: the autosave, the status and progress, MCP,
   the ComfyUI events, every IPC call of the window. That is the app "hanging". In the utility process main's longest
   block was 0 through the same DirectML jobs (§1.5), so **U1 removes this part whole**.
2. **The object map is about 1.9 s, every time the picture changes.** The hover tool needs the map before it shows
   anything; a stroke, a filter or a landed result makes it stale (`updateObjectHover`, `inpaint_canvas.js:12892-12900`),
   and the next hover builds it again. The model is two thirds of it (16 batches of 64 points; the export allows no
   other batch size), **JavaScript one third** (the stability filter and the Int8 copy of all 837 candidates, then NMS
   and the paint). A smaller SAM2 does not help the map: all four sizes run the same decoder (1.88 s tiny, 1.95 small).
3. **The cold start comes back often.** The first hover of a session pays the two sessions' load on top (3.1 s at 6k in
   the editor). Free VRAM drops them, and the app frees the helpers **before every local ComfyUI run** once a helper was
   used (`inpaint_canvas.js:24553`), so after each local Generate the next hover waits 2.8 s again.

**On large pictures the window adds its own** (U1 does not touch it): at 15000 x 8438 a hover over a new object blocks
the window 0.28-0.33 s (`objectShape` draws a canvas of the whole document for each object), a click 1.3-2 s, the
map's scale-back 0.24-0.53 s, and the 13 kept shapes hold 5-6 GB in the GPU process (§1.4).

Not the problem: a warm point (7-8 ms; `select_point` with its selection 0.1 s), depth on DirectML (0.24 s, though it
blocks main for all of it), RMBG-1.4 (0.6-0.8 s).

## 3. U1: the helpers in a utility process

### 3.1 The shape

One Electron **utility process** owns the ONNX runtime for SAM2, the matting models and depth: its own `Runtime`
(`runtime.js`), one `Sam2` per encoder file with **its embedding cache** (the last three pictures, `sam2.js:54,
68-71`), `Matting`, `Depth`. It is LaMa's pattern (`lama.js:76-176`, `lama_process.js`), and U0's probe
(`tools/helpers_process_probe.js`) is that process without the plumbing: the same modules, loaded unchanged in a
utility process, ran every job U1 needs on DirectML and on the CPU (§1.5).

- **New `electron/main/onnx/helpers_process.js`** (the process; `lama_process.js` grown): `process.parentPort` messages
  `{ id, type, ... }` -> `{ id, result }` / `{ id, error }`, every answer carrying the runtime's `status()` (what is loaded
  on which provider, the failures), so main can answer `helpers:status` without asking.
- **New `electron/main/onnx/engine.js`** (pure, no Electron: the jobs' bodies moved out of `index.js:197-322`):
  `engine(runtime)` -> `{ objects, segment, cutout, depth, free, status }` with the `Sam2` / `Matting` / `Depth`
  instances keyed by file path. The process and the main-thread fallback run the same object, as LaMa's `engine(ort)`
  (`lama.js:33-73`) is shared. `checkImage`, the out-size clamps and the answers stay byte for byte what `index.js`
  answers today, so `host.js` does not change.
- **New `electron/main/onnx/helpers.js`** (main's side, `Lama`'s class shape): `HelperProcess` with `call(type, payload)`,
  a pending map by id, `kill()`, `busy()`, the idle timer (§3.6), the fallback (§3.3) and `lastStatus`.
- **`index.js`** keeps what needs settings or Electron: the folder, the links, `presentOf` / `models.paths` (main
  resolves the files and sends `{ model: { id, label, input, mean, std }, files }` with every job; the process never
  reads `settings.json`), the downloader, `busy`, the IPC facade. Its `objects` / `segment` / `cutout` / `depth` become
  `proc.call(...)`; `sam2Instances` / `mattingInstances` / `depthInstances` go (the engine holds them).
- **LaMa stays in its own process** (§6 Q4).

### 3.2 What crosses the port, and what it costs

| Job | In | Out | The copy (§1.5) |
|---|---|---|---|
| `objects` | the 1024² RGBA, 4 MB (always sent, `host.js:6526`) | the label map, `Uint16Array` outW x outH (4.5 MB for the scene; 4.7 MB at 15k, 2048 x 1152) | about 9 ms each way per 4 MB |
| `segment` | the key and the points; the picture only after a miss (`host.js:6612-6617`) | 256² `Float32Array` logits, 256 KB | under 1 ms |
| `cutout` | 4 MB | 1 MB alpha | about 11 ms |
| `depth` | 924 x 518 RGBA, 1.9 MB (1568 x 882: 5.5 MB) | `Float32Array` of the same count | 5-15 ms |

The added copy is about 1 % of an object map and nothing for a click. **Main relays** (the window -> main -> the process
and back), as for LaMa; no `MessageChannelMain` straight from the window to the process. That would save main's own
copy (a 16 MB echo held main 22-30 ms; a 4 MB one never showed as a block), but it splits the busy set, the
fallback and the kill over two places, and the numbers do not ask for it (§6 Q6).

### 3.3 The fallback and crashes

- **The process cannot start or dies before its first answer** (no utility process under plain Node, onnxruntime
  missing in it, a DirectML device it cannot make): the engine runs on main's thread from then on and the jobs that
  waited run there (`lama.js:115-134`), with one console line. That is today's behaviour, so nothing gets worse.
- **It dies after answering** (a device removed, an out-of-memory in the provider): the pending jobs are refused with one
  plain sentence ("The helper models' process stopped; try again."), `lastStatus` is cleared, and the next job starts a
  new process. A second death within 60 s falls back to the main-thread engine for the session (§6 Q5).
- `segment` without a picture for a key the process does not hold answers the error it gives today (`index.js:229-230`
  reaches `checkImage`), so `host.segmentLogits`' retry with the picture (`host.js:6613-6617`) covers a new process too.

### 3.4 Free VRAM, the device, the folder, the quit

| Event | Today (`index.js`) | U1 |
|---|---|---|
| Free VRAM (`helpers:free`: the button, and `freeHelperModels` before a local ComfyUI run once `helperUsed`) | `runtime.free()` on main: every session released, **main blocked 0.13-0.37 s**, the caches cleared | **`kill()`**: the process ends where it stands (8.7 ms to its exit in the probe, the card's memory back at once); nothing blocks main. A "free" message instead (the process kept) took 0.53 s and left 0.36 GB in it; the kill gives back everything, and the restart costs the spawn and the ORT load (about 50 ms) on top of the session loads a free costs anyway |
| The device switch (`configure({ device })`) | `runtime.setDevice` + `free()` | `kill()`; the next start sends `init { device }` |
| A folder change, Scan, a model's removal (`clearInstances`, `remove`) | instances dropped, `free()` | `kill()` (the files' paths change) |
| The quit (`will-quit`, `index.js:105`) | LaMa killed | the helpers process killed beside it |
| `helpers:status` | `runtime.status()` (sync) | `lastStatus` from the last answer and `{ process: { pid, state: "off" \| "starting" \| "ready" \| "fallback" } }`; Settings' runtime line says "not loaded" while the process is off |

`editor.helperUsed` and `freeHelpers` (`host.js:6849-6855`) stay as they are: they still call `helpers:free`.

### 3.5 Several jobs at once

The process is one JavaScript thread, and each `session.run` is a synchronous native call behind a `setImmediate`, so
between the automask's 16 decoder batches (`sam2.js:122-151`, each an `await this.decode`) the process takes its next
message. **A click during an object map** is answered after the batch in flight (about 80 ms of decode and 33 of
filter), not after the whole map, as long as the engine does not queue jobs behind each other. The rules: one encode in
flight per key (a second request for the same key awaits the first); `Runtime.session` already shares a load
(`runtime.js:41-48`); a newer `objects` request of the same document (the key's `node.id:` prefix) marks the older one
stale, and its automask stops at the next batch (the window drops its answer today anyway, `host.js:6527`). The busy
set in main stays per job type.

### 3.6 The idle unload (the user's pick, 2026-11-07)

The process ends **N minutes after the last helper job ended** (the timer restarts at every answer and never runs while a
job is pending), so SAM2's 6.2 GB of private bytes and 5.6 GB of VRAM (§1.3) go back to the system. Coming back is a
cold start: the spawn and ORT about 50 ms, SAM2 base+'s two sessions about 1.1-1.2 s, the encode 40-70 ms, the first
decode of each shape 0.2-0.3 s; the first hover after every local ComfyUI run pays as much today. Suggested N: 5 (§6 Q1).
Picking the object tool then warms it (U2 item 1), as picking Remove warms LaMa (`inpaint_canvas.js:3564`,
`host.js:6363-6368`).

### 3.7 DirectML in a utility process

U0's probe ran every DirectML job in a utility process forked from Scumble's main process (SAM2 base+'s cold call, the
points, the object map, BiRefNet lite, Depth Anything V2 Small) with the same answers as on main and the same times
within the spread, and `kill()` gave the card's memory back. I0b of `docs/PLAN_CORRIDORKEY.md` had created DirectML
sessions in a utility process of a separate Electron entry before. **Not run:** the packaged exe (`app.asar`, with
`onnxruntime-node` unpacked; LaMa's process loads it in the shipped app), the Store's MSIX (LaMa's utility process runs
there; DirectML from one is unverified), Linux (the build carries no CUDA provider, `HELPERS.md` "Not done", so the CPU),
macOS.

### 3.8 Tests (U1's tier: normal, plus the measurement)

- `node tools/helpers_test.js --process` (plain Node, the forked Node process path of `lama.js:84-85`): the synthetic
  picture's objects, a point, a cutout and a depth map through `HelperProcess`, the answers equal to the main-thread
  engine's (the same `ids` bytes with and without `--process`); a kill during an object map refuses it and the next job
  starts a new process; a script that exits at once falls back to the main-thread engine with the queued jobs answered.
- A gate step (in `selection`, or a gate `helpers`; `--offline`; skipped where no SAM2 model is present, as
  `helpers_test.js` skips): `helpers:objects` and `segment` in the app with the process's pid alive, main's longest
  event-loop gap during the map under 50 ms (the sampler of `tools/helpers_perf.py`), Free VRAM -> the pid gone and the
  next point starting it again, the device switch to CPU -> the next answer's provider `cpu`.
- `tools/helpers_perf.py --batches gpu,editor` before and after into `docs/measurements/u1_<date>/` (U1 adds a mode that
  reads the process's own per-job times, as the probe reports them; main's wrappers see nothing once the work moved).
- `lint`, `types`; the gates that reach the helpers (`selection`, `maps`, `depth`, `limit`, `key` with its stubs) on
  tiles.

## 4. U2: what would make it faster beyond the move

U1 takes the blocks off main; the user still waits as long as now. Ranked by what the user feels:

1. **Warm SAM2 when the object tool is picked** (as Remove warms LaMa): start the process, create both sessions, run one
   dummy decode at B 64 and one at B 1 (each shape's first run costs a DirectML plan, 0.2-0.3 s), and encode the
   current picture. The first hover then waits for the map alone (about 1.9 s) instead of 2.8-3.1 s. Small (with U1b).
   It holds the VRAM only while the tool is in use (the idle kill gives it back).
2. **The object shapes at the map's size, not the document's** (the window, not ONNX): `objectShape(id)`
   (`inpaint_canvas.js:12875-12890`) draws a canvas of the whole document per hovered object and keeps 13; the ids
   themselves are a nearest upscale of the label map of at most 2048 px (`host.js:6528-6538`). Keeping the ids and the
   shapes at the map's size (2048 x 1152 at 15k, a sixtieth of the area) and drawing them scaled with smoothing off gives
   the same pixels; the click draws the small shape scaled into the selection. At 15k that takes the hover's 0.3 s,
   most of the click's 1.3-2 s, the scale-back's 0.24-0.53 s, the 253 MB id array and the 5-6 GB of kept shapes
   (`docs/BUGS.md` "The object tool's hover shapes are canvases of the whole document"). `objectIdAt` then maps the
   cursor into the map; the ComfyUI helpers' map (`applySegmentsFile`) takes the same path. `inpaint_canvas.js` ships in
   the node, so the node gets it with its next build. Normal tier (a selection path: the selection's bytes against
   today's on both backends). One session.
3. **The automask's JavaScript** (`sam2.js:128-190`): a third of the map. The stability filter runs over every mask that
   passes the IoU threshold, and the Int8 copy is made for every candidate (837 of 3,072 masks on the scene, of which
   NMS keeps 95); then NMS and the label paint (95 ms). A fused single pass, the Int8 copy only for what a box NMS on
   the candidates keeps, or a Rust kernel in the process (the user's rule: Rust wherever the whole operation is faster;
   the px build runs in Node, `tools/px_test.js`) could take the map from about 1.9 s towards the decoder's 1.3 s
   (inferred). The label map's bytes must stay the same (a twin test against today's `automask` on recorded decoder
   outputs). One session.
4. **The decoder's shapes**: one decoder session per shape (B 64 for the map, B 1 for points), or the map's B 64 run
   first. The editor's maps decoded in 818-995 ms against the `gpu` batch's 1,287, and the only difference found is the
   session's first shape (§1.4, inferred, not isolated). A measurement first (half a session): two sessions of the same
   file, each with its own shape, against one.
5. **Fewer grid points, or the hover by point** (a behaviour change, the user's call, §6 Q2): a 16 x 16 grid took
   0.54 s and found 47 objects instead of 95 (the small ones go). Or no map at all: the hover decodes one point at the
   cursor (7-8 ms warm), debounced, and shows SAM2's best mask there as a click does; the first hover after a picture
   change then waits for the encode (40-70 ms) instead of the map. "The smallest object under the cursor wins"
   (`sam2.js:169-170`) becomes "SAM2's best of three masks at the point".
6. **Keep SAM2 through a local ComfyUI run when the card has room**: `freeHelperModels` frees the helpers before every
   local run once `helperUsed` is set, so the next hover pays 2.8 s again. The card's free memory is known (`gpumem.js`);
   SAM2 base+ holds 5.6 GB after a map. The user's call (§6 Q3).
7. **Not worth it, measured:**
   - *A smaller SAM2 for the map:* one decoder for all four sizes, so tiny 1.88 s and small 1.95 s against base+'s
     1.93 s; a smaller model only loads faster (0.83-0.94 s against 1.1-1.2) and encodes in 20-40 ms instead of 37-65,
     with coarser masks.
   - *The decoder's batch size:* B 1 and B 64 only (§1.1); a re-export with a free batch dimension would be needed, and
     a DirectML batch of 64 points is already about 78 ms.
   - *SAM2 on the CPU:* an object map takes 38 s (24 threads). DirectML is the path; the CPU stays the fallback.
   - *Matting on DirectML in the process:* BiRefNet lite's warm run is 0.3-2.1 s on DirectML against 4.8 s on the CPU,
     but a kept DirectML session held 24.7 GB of private bytes (B5). Kept in the process it would be the process's
     memory, gone at the idle kill; still 24.7 GB while it lives. The "auto" device keeps the CPU.

## 5. Sessions

| Session | What | Files | Tests |
|---|---|---|---|
| **U1a** | `engine.js` (the jobs out of `index.js`), `helpers_process.js`, `helpers.js` (`HelperProcess`, the fallback, the kill, the idle timer), `index.js` routed through it; `helpers:status` from `lastStatus`; `will-quit`, `configure`, `scan`, `remove`, `free` kill it | `electron/main/onnx/{engine,helpers,helpers_process,index}.js` | `helpers_test.js --process`, `lint`, `types` |
| **U1b** | the gate step, the measurement after, `warmObjects` on picking the object tool (U2 item 1), the docs (`HELPERS.md`'s paragraph "Every model but LaMa runs on the main process's thread" and its "Not done" line, Settings' runtime line) | `tools/*_test.py`, `tools/helpers_perf.py`, `docs/HELPERS.md`, `renderer/editor/host.js` (`warmObjects`; the node's host answers it as a no-op, `build_node.py --check`), `renderer/editor/inpaint_canvas.js` (one line beside `warmRemove`) | the gate on tiles, `helpers_perf.py` before and after |
| **U2** | the items the user picks from §4; 2 and 3 first | per item | per item |

About 1.5 sessions for U1 (inferred); U2's items 2-4 about one session each.

## 6. Open questions for the user

Each has a suggested answer; with no answer by the session that needs it, that answer is taken and the hand-over says
so (`docs/PLAN_WASM_BUILD.md` §6's rule).

1. **The idle unload's minutes** (U1a): the process ends that long after the last helper job and gives back SAM2's
   6.2 GB of RAM and 5.6 GB of VRAM; coming back costs a cold start (about 1.5 s before the map). *Suggested: 5.*
   (2 frees the card sooner for ComfyUI; 10 keeps the object tool warm through a longer edit.)
2. **The object map's shape** (U2 item 5): the 32 x 32 map as now (the smallest object under the cursor, about 1.9 s per
   picture), a 16 x 16 map (0.54 s, about half the objects), or the hover by point (no map: SAM2's best mask at the
   cursor, 7-8 ms after a 40-70 ms encode). *Suggested: keep the map, do items 1-4 first, ask again with their numbers.*
3. **Free the helpers before a local ComfyUI run only when the card is short** (U2 item 6) instead of always.
   *Suggested: no change now* (U1's kill makes the reload cheap for main; the wait stays 1.1-1.2 s).
4. **LaMa in the same process** as the other helpers, or its own as now. *Suggested: its own* (a Remove's 1.5 s CPU run
   would wait behind an object map, and the reverse; LaMa never uses the GPU).
5. **A process that dies twice within a minute**: fall back to the main thread for the session (today's behaviour, with
   its blocks), or refuse the helpers with a red line until the next start. *Suggested: fall back*, so the tools keep
   working.
6. **A port straight from the window to the process** (`MessageChannelMain`) instead of main relaying the pictures.
   *Suggested: no* (§3.2: about 1 % of an object map, and one place for the busy set, the kill and the fallback).
7. **The shapes' memory at 15k** (§1.4, U2 item 2): the GPU process held 5.4-6.4 GB with 13 kept shapes, up to 14 GB for
   a few seconds after they were dropped, 1.5 GB after 20 s. *Suggested:* U2 item 2 right after U1a, before the other U2
   items: it is the window's own fix, independent of U1, and the largest wait the user meets on a 15k picture.

## 7. U1 as built (2026-11-07)

U1a and U1b's gate step, measurement and docs in one session; **`warmObjects` (U2 item 1, the U1b row's
`renderer/editor/host.js` / `inpaint_canvas.js` part) is not built**: another agent edits those files tonight, so it
waits for a later session. §6's questions 1, 4, 5 and 6 had no answer by this session and went with the suggested
answers (the plan §6's rule): the idle unload after **5 minutes** without a helper job; **LaMa stays in its own
process**; a process that dies twice within a minute **falls back to main's thread**; **no port straight from the
window** (main relays).

- **`electron/main/onnx/engine.js`**: `engine(runtime)` with the jobs `objects`, `segment`, `cutout`, `depth` (the
  bodies of `index.js` before, the same answers field for field), the instances keyed by their files, `free()`,
  `clear()`, `status()`; `checkImage`, `checkDepth`, `modelInfo`. One encode in flight per key (§3.5): a second job for
  a picture being encoded awaits that encode, and a point without its picture waits for it too instead of being
  refused. The stale-map rule of §3.5 (a newer map of the same document stopping an older one) is not built: the window
  drops the older answer, as before.
- **`electron/main/onnx/helpers_process.js`**: loads onnxruntime first (a process that cannot ends before "ready"),
  posts `{ type: "ready", pid, status }`, answers `{ id, result | error, ms, status }`. Every job carries the device
  (`runtime.setDevice` per job, a no-op unless it changed), so there is no `init` message.
- **`electron/main/onnx/helpers.js`**: `HelperProcess` (`call`, `retire({ reason, clear })`, `kill({ reason, clear })`,
  `busy`, `status(device)`, `onJob`; `IDLE_MS` 5 min, `DEATH_WINDOW_MS` 60 s, `DRAIN_MS` 8 s; each process holds its
  own pending jobs). "Ready" and not "the first answer" decides the fallback: a process that crashes during its first
  job (a DirectML fault) is a death, not a failed start, so the job is refused and the next one starts a new process
  instead of running the crash on main. **`retire`** (Free VRAM and the free before a local run, which come as the same
  `helpers:free`; the device switch; a folder change; a scan; the review of U1, below) sends new jobs to a new process
  at once and ends the old one once it has answered its jobs, at most 8 s later, refusing what is still open with a
  sentence naming the cause (`REASONS`); **`kill`** (a model's removal, the quit) ends the current process and every
  retiring one where they stand, refusing their jobs with the cause. Both resolve once the processes exited (at most
  2 s after the kill) with the sessions the current one held, so `remove()` deletes a file only after no process holds
  it; in the fallback both free the engine's sessions (and with `clear` drop its instances), as before U1. A kill
  before the utility process's "spawn" (its `kill()` does nothing then) is done at the spawn.
- **`electron/main/onnx/index.js`**: the settings, the files (`jobModel`: `presentOf` + `models.paths`), the busy set
  and the IPC facade; main checks the picture (and a depth job's sides) itself first, so the errors and their order are
  today's and a refused request starts no process. `configure` writes the settings before it retires the process (a
  job that comes in meanwhile goes out with the new device and folder); a device change retires, a folder change and a
  scan retire and clear, a model's removal (linked or not; a LaMa model leaves the helpers alone) kills and clears;
  `free` retires; `will-quit` kills beside LaMa. `helpers:status`' `runtime` is `helperProcess.status(device)`: `device` and `candidates` from the settings, the
  sessions and failures from the last answer (failures kept after a kill), `version` from the last answer or
  `onnxruntime-node/package.json` (main never loads the binary), `process: { pid, state }`. `helperProcess` is exported
  for the tests and the harness. Settings' runtime line needed no change ("nothing loaded yet" while the process is off).
- **Tests**: `node tools/helpers_test.js DIR --also APP --process` (SAM2 tiny, RMBG-1.4, Depth Anything V2 Small on
  DirectML): every answer byte for byte the main-thread engine's (the label map, the logits, a box prompt's mask, the
  alpha, the depth map), status from the last answer, Free VRAM during a map (the map lands, the process ends after
  it, a job meanwhile goes to a new one; one longer than the drain refused naming the cause), a removal's kill during a
  map (refused at once with its cause), a point without its picture on a new process refused,
  a death refused and a second within the minute falling back (the same bytes on this thread), a process that exits at
  once falling back with its job answered, the idle unload never during a job: PASS. The new gate **`helpers`**
  (`tools/helpers_test.py`, `--offline`) runs that, then in the app on the user's ComfyUI models folder (read only):
  a cold map with the process in the metrics and the IPC round trips at most 9.7 ms, the editor's map, `select_point`
  and `cutout_layer` through it (round trips at most 71 ms: the window's own work), Free VRAM ending the process and
  the next point starting another, Free VRAM during a map (the map lands, a point sent meanwhile answered by a new
  process), the device switch to the CPU: PASS on tiles. The gate holds the busy lock while it runs (at most 5 minutes'
  wait) and `tools/run_gates_both.sh` runs it serially. `lint`, `types`, `selection`, `maps`, `limit`, `key` PASS on tiles; `node tools/depth_test.js` (the
  `depth` gate's stand-in) all ok.
- **Measured** (`docs/measurements/u1_2026-11-07/`, `compare.txt`; `--quick`, the gpu and editor batches, one run each
  under the busy lock): main's longest block 1,159 -> 21 ms for SAM2's first call, 226 -> 22 for a map, 330 -> 0 for
  Free VRAM, 1,001 -> 0 for a map after Free VRAM, 2,613 -> 21 for a BiRefNet lite cutout on DirectML, 681 -> 24 for a
  large depth map, 1,074 -> 0 for the editor's first hover map; what is left is main relaying the answers. Main's
  private bytes stay at about 83 MB (SAM2's 3.5-8.6 GB live in the process). The waits are unchanged in the gpu batch;
  the editor's cached map took 1,675 ms against 1,432 and its point 161 against 51, one run, not isolated (U0's probe
  saw the same map-first time in a utility process, §1.4; U2 item 4).
- **Not run**: the packaged exe, the MSIX, Linux, the canvas backend (no pixel path changed).
- **The review of U1** (three findings, 2026-11-07): every free killed the process and refused its jobs, the free a
  local Generate does by itself included, so a cutout on another tab or an agent's second call failed red: the free,
  the device switch, a folder change and a scan retire the process instead (above), the removal and the quit kill it,
  and each refusal names its cause. A kill in the first milliseconds left the utility process alive (its `kill()` does
  nothing before "spawn"): it is done at the spawn. The gate took no busy lock and ran on both sides of
  `run_gates_both.sh` at once: it holds the lock now and runs serially.
