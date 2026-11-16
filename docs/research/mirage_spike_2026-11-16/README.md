# Mirage spike (item 53), 2026-11-16

The spike that `docs/research/mirage_2026-11-07/README.md` asked for: Cactus Compute's Mirage run on 12 pictures in plain
Node through the engine's wasm build, with the network blocked. No app code was touched. The scripts and every raw
output are in the session scratchpad (`.../scratchpad/mirage_spike/`, `run.js`, `overlay.py`, `summ.js`, `out_*`).

## Verdict

**Not worth building as a helper now.** The boxes are good on large, salient objects (cars, people, wheels), but the
detector misses main subjects, names wrong things with the same confidence as right ones, and `keywords` rename existing
boxes instead of finding new ones (with "cake" as a keyword the orange sports car came back as "cake 0.817"). That rules
out selection by name, the one use that would have justified shipping a closed-source engine. OCR line boxes on clean
Latin text are the only output that works well. German diacritics come back right in 2 of 7 cases.

## Files (downloaded on the user's yes, checked before use)

All four sizes and sha256 hashes matched what was approved. The files went into their own empty folder, the scripts
lived in another one, and the wasm was passed as `wasmBinary` so the glue never fetched anything.

| File | Bytes | sha256 |
|---|---|---|
| `mirage.cact` (HF `Cactus-Compute/mirage` @ `76c1e9e5...`) | 21,611,043 | `4249a0f7515272ff76b9414bec17d7e7daf84b15b66c7fb4f17fce1e66f9f237` |
| `cactus.wasm` 4.1.1 (HF `Cactus-Compute/cactus` @ `d2c5cd70...`) | 1,240,671 | `2de0a4459ed427c258157fcb6128265f72f405e7464b25d713bbd336b15bcacf` |
| `cactus.js` 4.1.1 | 62,247 | `707341e44776ab0eb8dfc8f6a579ed5ac41e2ffc6419a18012f61619a6dfc70c` |
| `manifest.json` 4.1.1 | 8,897 | `27168631232dbff52a205b54bbfad54fd9b81f06fa368657d07449e2221f5e25` |

## How offline was proven

1. **The wasm's import list** (`WebAssembly.Module.imports`) has 16 functions. Mapped through the glue's `wasmImports`
   table they are `__cxa_throw`, `fcntl64`, `ioctl`, `openat`, `rmdir`, `unlinkat`, `abort`, `munmap`,
   `clock_time_get`, `emscripten_resize_heap`, `environ_get`, `environ_sizes_get`, `fd_close`, `fd_read`, `fd_seek`
   and `fd_write`. The file calls go to Emscripten's in-memory file system in the glue, and there is no socket call. A
   wasm module can reach nothing outside its imports.
2. **An in-process block, installed before the glue loaded.** A `Module._load` hook threw on `http`, `https`, `net`,
   `tls`, `dns`, `dgram`, `http2`, `child_process`, `worker_threads`, `inspector` and `undici`. Getters on
   `globalThis.fetch`, `XMLHttpRequest`, `WebSocket` and `EventSource` recorded and threw on any access, even a
   `typeof`, and `net.Socket.prototype.connect` threw too. Over every run, all of them with this block in place, the
   recorded attempts were `[]`. The only module the glue required was `node:fs`.
3. The glue's `fetch` and XHR code paths only load the `.wasm` when no `wasmBinary` is given, plus Emscripten's lazy
   files, which are never used. No OS firewall rule was set, since that would have meant changing a system setting.

## API facts found (engine 4.1.1)

- `cactus_load(ptr, n)` takes `n` as a **BigInt** (an `unsigned long long` under WASM_BIGINT). Passing a Number throws.
- `cactus_set_threads` exists in 4.1.1. The wasm build is single-threaded, so it was called with 1 and changes nothing.
- `cactus_describe` returns rc > 0 on success. On failure it returns -1 with a plain error text: unknown option names,
  wrong value types and unsupported languages are refused. Unknown top-level keys are accepted silently.
- `sections`: `scene objects regions text relations events reasoning`. Leaving `sections` out returns all of them.
- `fields`: `bbox score mask position description`.
- `mask_format`: `largest | merged | polygons | bitmap`. The default is polygons, as flat `x, y` lists on 0..1000.
- Other keys: `conf` (default about 0.3), `text_conf`, `max_objects`, `max_text_lines`, `max_tokens`, `nms` (bool),
  `form` (an object).
- Languages: `en de fr es it nl pl`. Anything else gives "unsupported language".
- Output was valid JSON in **all 123 calls on real pictures** (no `nan`).
- The output is deterministic: the same input in a new process gave byte-identical JSON.

### Box and mask layout

- **`bbox` is `[x1, y1, x2, y2]` on 0..1000 of the picture's own width and height** (not of the letterboxed square).
  Text lines use the same layout.
- **`mask_format: "bitmap"` is COCO-style RLE over the whole picture**: `{"size": [h, w], "counts": [...]}`. The runs
  alternate, background first, in **column-major (Fortran) order**. Proof: the bounding boxes of the decoded masks match
  the given `bbox` at a median IoU of 0.949 (mean 0.911, 93 objects) read column-major, and 0.096 read row-major. The
  mask is full size, not cropped to the box. Its edge follows the model's 128 grid (steps of about 8 px at 1,024 px).
- `id` is **not unique**. Several instances of one class share an id (eight "tree" objects all have id 1), so the
  `relations` entries, which point at ids, are ambiguous.
- `regions` entries have a name, position and description but **no box and no mask**, so they are of no use for
  selection.

## Test set

All pictures were scaled so the long side is at most 1,024 px, and packed RGB was fed to the model.

| # | Picture | Source |
|---|---|---|
| 01 | Woman on a car, street | `docs/images/tutorial/scene.jpg` |
| 02 | Rest stop at night | `genesis-magma-gt/renders/047_raststaette.png` |
| 03 | Room with fireplace | `genesis-magma-gt/renders/063_kaminzimmer.png` |
| 04 | Garage, woman and car | `genesis-magma-gt/renders/071_luxusgarage.png` |
| 05 | Car studio shot | `porsche-targa-gts/references/ref_01_targa_gts_studio.jpg` |
| 06 | Mug product shot | the left half of an older scratchpad picture |
| 07 | Woman with hat, field | `genesis-magma-gt/renders/075_bollenhut.png` |
| 08 | Sheep on a road | `genesis-magma-gt/renders/055_schafe.png` |
| 09 | Café window | `genesis-magma-gt/renders/top/033_cafe_fenster.png` |
| 10 | Thumbnail with lettering | `docs/images/thumbnail.jpg` |
| 11 | English poster | drawn by the spike with Pillow |
| 12 | German poster with ä ö ü Ö Ü ß | drawn by the spike with Pillow |

The two posters give exact ground truth for OCR. The user's pictures were read-only, and copies stayed in the
scratchpad.

## Measurements

### Time

Node 24.18, the wasm on one thread, the user's machine.

| | Time |
|---|---|
| Instantiate the wasm | 9 to 11 ms |
| `cactus_load` | 41 to 54 ms |
| wasm heap | 169 MB |

The first `describe` costs about the same as the warm ones: no warm-up beyond the 50 ms of loading.

| Options | Warm time per picture (1,024 px), median and range |
|---|---|
| `objects` only | **1.8 s** (1.3 to 2.2) |
| `scene`, `objects`, `text` | 1.8 s (1.3 to 2.5) |
| All sections with masks, `en` | 2.4 s (1.5 to 4.2) |
| All sections with masks, `de` | 3.0 s (2.1 to 5.0) |

- Feeding 512 px instead of 1,024 px saves nothing. It does change the answer: the name sets differed on 9 of 12
  pictures, and only the 512 px input found the red sports car in 02.
- A lower `conf` (0.15) adds mostly repeats: 25 "street light" boxes in 02 and 17 "car" boxes in 09.

### Objects

There are 93 objects at the default threshold. By eye, about three quarters of the names are right. The errors come
with the same scores as the hits.

- **Good:** cars in 01, 03, 04, 05, 07, 08 and 09 (scores 0.6 to 0.9, tight boxes, usable masks); the woman in 01, 04
  and 07; the wheels, headlight, windshield and mirror in 05; the hat and the house in 07; the plate and table in 09;
  the poster's circle.
- **Missed:** the main subject of 02 (the red sports car is only a box-less `region`); the trucks; the handbag in 01; the
  man and the dog in 08 (in English; German found the man); the cup and cake in 09; the big armchairs in 03.
- **Wrong names:** the sheep flock is "crowd" and "cow" (German: "Menschenmenge", "Felsen"); the lace curtain in 09 is
  "chandelier"; the "fireplace" box in 03 sits right while the fire is on the left; the left truck in 02 is "car"; the
  poster is "book cover" with an invented `description.content` ("the soul of the soul").
- **Boxes over everything:** "logo" over the whole thumbnail, "wall" and "chandelier" over half of 09, "cow" over the
  whole flock.
- **Language:** boxes and scores are identical in `en` and `de` (the detector does not depend on the language). The
  names are decoded per language and do not match each other: the same box [139,691,459,884] at 0.781 is "plate" in
  English and "Esstisch" in German, and [7,499,989,980] is "cow" and "Felsen". So German words cannot be matched by
  translating the English names, nor the other way round.
- **`keywords` rename, they do not detect.** The boxes stay those of the run without keywords. Their names move toward
  the given words:
  - In 09, "cup, cake, fork, window" turned the sports car box into "cake 0.817", the plate into "cake stand", the
    curtain box into "window" and a white car into "fork".
  - In 02, "orange sports car, truck, gas station" did not find the car. It turned the sign and the "car" box into
    "truck".
  - In 08, "sheep" relabelled the flock box (correctly, as one box). "man" took a tiny box at 0.302, not the real man.

### Masks

The masks are coarse and blobby, with holes in the textured areas (the woman in 01, the car in 04, the wall in 09).
Edges step on the 128 grid. Shapes are fair for big solid objects and poor for thin or textured ones. They never land
raw: SAM2 refinement would always be needed.

### OCR

The text section does not depend on the language.

- **English poster:** all 5 lines read exactly ("SUMMER SALE", "50% OFF ALL SHOES", "Open daily 9am - 8pm", "Corner
  Store", "123 Main Street"), each with a tight line box. There are also 7 overlapping fragments ("SUMMER", "50% OFF",
  "pen daily 9an", ...) that would have to be merged.
- **German poster:** 0 of 5 lines exact. "Bckerei Müller", "Frische Brótchen", "GroBe Überraschung",
  "Offnungszeiten 7 - 18 Uhr", "StraBe der Einheit 12". By character: ü and Ü are kept; ä is dropped, ö becomes ó,
  Ö becomes O, and ß becomes B twice, so 2 of 7 come back right. The line boxes are good.
- **Thumbnail:** "SCUMBLE", "BALMAIN" and most caption lines read. Line ends are cut off ("ANY AF", "AYERS THAT STAY
  EDITABLE", "...scumb"), and the T-shirt print gives garbage ("EEGEERr", "AmaH5TLEE").
- **Text where there is none:** "V" on the mug, "ir" among the sheep, "Os Ketn" at the rest stop, and "S" and "." on a
  flat grey test picture.

### Scene, relations, events, reasoning

- The `scene` record is plausible ("living room, warm, night, cozy"). It is also wrong at times ("city street, urban
  intersection" for the rest stop) and invents a mood ("festlich" for the sheep).
- `events` were always empty.
- `relations` are sometimes wrong ("woman standing_on car" in 01) and ambiguous through the shared ids.
- `reasoning` is a short English trace even for `de`. It loops on posters ("the soul of the soul" repeated) and on a
  flat grey picture ("and and and ...", which runs to `max_tokens` and takes minutes).

## Overlays

Coloured masks with boxes and English names; white thin boxes are OCR lines.

- `room_en.jpg`: 03. The car, the window and the snow are right; the "fireplace" box is on the wrong side; the
  armchairs are only partly found.
- `cafe_en.jpg`: 09. The sports car and the plate are right; "chandelier" is the lace curtain; the cup is missed.
- `poster_en.jpg`: 11. The OCR line boxes are right; the "text" objects are nested and duplicated.
- `poster_de.jpg`: 12. The OCR line boxes are right; the readings lose ä, ö, Ö and ß.

No overlay shows a person. The two posters are the spike's own.

## The four uses

- **(a) Selection by name without ComfyUI** (boxes refined by SAM2): **no.** Recall is too low for anything but
  salient objects, names are confidently wrong, and `keywords` invent matches (car as "cake"). A typed word would
  select the wrong thing with no warning. SAM3 through ComfyUI stays the route.
- **(b) Names on hover:** weak. The names are about three quarters right, cover only what Mirage proposed (a few to 14
  objects a picture), and would need matching to SAM2's segments. Each picture takes 1.8 s. The worth is small against
  a closed engine.
- **(c) Named Keep boxes** (FLUX 3 / Ideogram 4): weak. The boxes for the main elements are good when they are found.
  But the main subject can be missing (02), and boxes over the whole picture ("logo", "book cover", "wall") would have
  to be filtered out. At best a "suggest boxes" button whose boxes the user checks.
- **(d) OCR text selection:** the best of the four, for its **line boxes**, which are tight on clean lettering. Its
  **readings** are fine for plain English and wrong for German diacritics. Selecting lettering to remove needs only the
  boxes, through SAM2 or a slightly grown box. Replacing text needs the reading, which fails on German words. There is
  false text on pictures without any.

Nothing here is worth building now. If one thing is ever built, "select text" (OCR line boxes, then SAM2 or a grown box)
is the candidate: small, useful for removing lettering, independent of the bad names. It is still not enough to justify
a closed-source engine on its own. Recheck if Cactus publishes the source or ships a better model.

## What an integration would need (if the user decides otherwise)

- **Route A of the 2026-11-07 research:**
  - `cactus.js` and `cactus.wasm` in a renderer Web Worker (the glue's worker path), with `wasmBinary` passed and no
    fetch.
  - `cactus_load` with a BigInt.
  - About 170 MB of wasm heap per worker.
  - One describe is a single synchronous call of 1.5 to 5 s with no way to cancel it inside, so a Cancel ends the
    worker.
  - Decode the RLE column-major. Take `bbox` as x1, y1, x2, y2 on 0..1000. Never trust `id` as unique.
  - The helpers process (LaMa's pattern) works as well, on the same glue in its Node branch.
- **Download entries:** `mirage.cact`, `cactus.wasm` and `cactus.js` (22.9 MB) with sha256, pinned on the revisions
  above, in Settings › Helpers, never in the installer.
- **Notices:**
  - About and the Helpers row: Mirage weights apache-2.0 (a model-card tag only, no LICENSE file); engine Apache-2.0
    binary, source not public; a plain closed-source note.
  - Store policy 10.2.2: describe the feature in the listing or switch it off in the Store copy. Flathub: the same
    question.
- **A gate step** with a stand-in for `describe` (the record layout above). A real-model check would need the 22.9 MB
  download in CI, so that check stays manual.
- **Not measured:** an Electron renderer worker (the same V8, so the same speed is expected); masks against SAM2 box
  prompts (left out because the names already rule out use (a)).

## Questions for the user

1. Do you agree with not building it now? Or do you want only "select text" (OCR line boxes) as a small optional
   download, knowing it runs a closed-source engine?
2. If "select text" is ever built: is removing lettering enough, or is reading and replacing it, German included, the
   point?
3. Should Claude draft a note to Cactus listing what the spike found? It would cover the source, a LICENSE file in the
   model repo, `keywords` relabelling existing boxes, the diacritics, and the ids that are not unique.
4. Can the four downloaded files in the scratchpad go when this session ends, or should they be kept for a later recheck?
