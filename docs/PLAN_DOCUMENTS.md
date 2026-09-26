# Plan: the `.scumble` document format (package 3b)

Written 2026-09-26 as the design pass of package 3b of `docs/PLAN_0_1_29.md` §3 ("an own document format that
reopens fully editable"), after 3a (quit safety) shipped in 0.1.29. Read-only pass over the tree at `d084e32`: nothing
was built, run or measured for this file. Every effort figure is an **estimate**; every timing quoted comes from an
earlier measurement named beside it.

**What to read first:** `docs/PLAN_0_1_29.md` §3; `CLAUDE.md` "How the app is put together" and "Tile engine code";
`electron/main/quit.js` and `electron/main/autosave.js` (3a, reused here, not redesigned).

**Testing tier: full** (CLAUDE.md "Working rules"): it can lose data. Both backends, a mutation round, a 15k
measurement. Each step ends in a local commit; nothing is pushed or released without the user's word.

## 0. The idea

A document already is its state JSON plus the files it names. `editor.getValue()` (`renderer/editor/inpaint_canvas.js`
11885-11927) writes every layer, mask, filter, text, selection, prompt and setting as JSON whose pixels are
references (`{ filename, subfolder, type }`) to PNG files in the local file mirror (`electron/main/files.js` 23-28);
`setValue()` (11929-12096) rebuilds the document from that JSON, streaming large PNGs into tiles in the pool (11945-
11950). The autosave (`renderer/editor/host.js` 1454-1472) is exactly that JSON per tab, and quit safety (3a) made sure
every edited layer is in the mirror before the JSON is written (`renderer/shell.js` 1931-1961).

So a `.scumble` file is **the autosave of one tab, made portable**: a zip holding that JSON and a copy of every
mirror file it names, byte for byte. Saving encodes nothing that the autosave does not encode anyway: the pixels were
already turned into PNGs by the pool (`inpaint_upload.js` 48-50, `inpaint_encode.js` 84-98); the save copies finished
files. Opening copies them back into the mirror and hands the JSON to `setValue()`, which is today's restore path.
No whole-picture buffer exists anywhere on either path, and no new pixel code is written.

## 1. What exists, and what the design takes from it

### Reused as it is

- **The state:** `getValue()` / `setValue()` (above). `get_state` already exposes it to agents (`renderer/commands.js`
  906).
- **The flush:** `syncLayers()` (`inpaint_canvas.js` 10943-10973) uploads every dirty layer and mask through
  `uploadPixels` (tiles: `encodeTilePixels` -> `writePng(tileRows)` in pool parts of about 8 MB,
  `inpaint_bands.js` 13-16, 157-167). One pass at a time per document, a layer clean from the start of its upload.
  `saveBeforeRestart()` (`shell.js` 1931-1961) adds the wait for a restore (`host._restoring`, `host.js` 187-189) and
  for the background selection encode (`encodeSelectionSoon`, `inpaint_canvas.js` 11829-11883, used above 16 MP).
  Measured in E2 (`docs/PLAN_BCE.md` 4003): a full 15k paint layer as a PNG takes 0.78 s wall, 6 ms blocked.
- **The ref walker:** `autosave.walkRefs` (`autosave.js` 142-147) and `host.referencedFileKeys` (`host.js` 1475-1488)
  find every `{ filename, subfolder, type }` in a state and turn it into a mirror key. Plain Node, testable.
- **Opening states as tabs:** `openGeneration()` (`shell.js` 1677-1688) puts states into new tabs with fresh ids through
  `host.restore()` (`host.js` 710-735), which counts `_restoring` so no autosave writes half a session.
- **Atomic small writes:** `autosave.writeJson` (`autosave.js` 31-36): a temporary file renamed over the old one.
- **The quit guard:** `QuitGuard.run(flush)` (`quit.js` 33-49) holds a close up to 120 s; `main.js` 265-284 runs it
  on close, 859-865 before an update's installer.
- **The export policy of the assistant:** `exportRow` (`electron/main/assistant/policy.js` 180-192) asks before every
  file write, says "overwritten" when the file exists, refuses without a path; `statFile` (`main.js` 431-434) gives
  the facts.
- **The thumbnail:** the ORA writer's 256 px picture from `sampleRegionSettled` (`inpaint_canvas.js` 8617-8619).

### Not reused, and why

- **The ORA writer** (`OraBandWriter`, `inpaint_bands.js` 325-373) builds the whole file as a Blob in the renderer and
  refuses above 4 GB (362, 368: no zip64). **The ORA reader** (`unzip`/`readOra`, `inpaint_layered.js` 344-427) needs
  the whole file as one byte array. A 15k document with several layers and its result history can pass 4 GB.
- **`file:save` / `file:open`** (`main.js` 583-617): `openImage` reads the whole file and sends it over IPC (588-590);
  `saveFile` writes bytes it received whole with `fsp.writeFile` straight onto the target (615), no temporary file.
  Right for a picture export, wrong for a document.
- **An ORA-compatible stack** (stack.xml with baked layers): scaled, masked and filter layers would each need a
  re-render (`exportLayerSources`, `inpaint_canvas.js` 8545-8571, draws such a layer into a canvas of its size), every
  layer would be stored twice, and a merged picture costs 6.2 s at 15k, 9.5 s with the film look (`PLAN_BCE.md`
  4004-4005) on every save. Krita or GIMP would also rewrite the zip and drop the Scumble part. Export > ORA / PSD stays
  the way into other apps (open question 4).

### Traps found while reading (they shape the design)

1. **An unknown filter id becomes grain on restore.** `setValue` 11995: `FILTERS[l.filter] ? l.filter : "grain"`,
   params merged over grain's defaults. A film layer in a document opened where the film plugin is off (or a user
   plugin's filter elsewhere) turns into grain, and the next save writes grain. The same happens to today's autosave
   when a plugin is switched off. `applyFilter` already passes the picture through for an unknown id
   (`inpaint_filters.js` 997-999), so the fix is to keep the id and params (step D2). This is the only editor change.
2. **3D layers keep their editability outside the document.** The glb plugin stores `{ ref, params, depthId }` per
   layer id in its global plugin storage (`plugins/glb/main.js` 30-40, `renderer/plugins.js` 639-645), not in
   `getValue()`. A `.scumble` opened in another profile would show the render but "Edit 3D object" would say the
   settings are gone, and the model file would not be in the file. A per-document plugin store is needed (§3.6).
3. **Mirror names are not unique across profiles.** Hash-named uploads (`n<id>_layer_<hash>.png`, `inpaint_upload.js`
   44-50) are, but an opened image keeps its own name with a "(1)" suffix on collision (`uploadBlob(... { overwrite:
   false })`, `inpaint_canvas.js` 9062; `freeName`, `files.js` 37-43), and fonts are written by name with
   `overwrite: true` (8448). Two different pictures can be `input/inpaint_canvas/photo.png` in two profiles. Opening
   must never write over a mirror file other documents use (§3.5).
4. **Ctrl+S is bound twice today:** the menu's "Save Image..." accelerator (`main.js` 503) and the editor's own key
   handler (`inpaint_canvas.js` 2258, a window capture listener, 1983). And **Ctrl+Shift+E merges down** now: the
   Ctrl+E check (2248) ignores Shift.
5. **The second instance's argv is dropped:** `app.on("second-instance", () => showWindow())` (`main.js` 981, 928);
   `parseArgs` (49-58) ignores non-flag arguments. A double-clicked file reaches nobody.
6. **Large uploads pass main as one Buffer:** `handleRawUpload` (`files.js` 119) holds a whole layer PNG (a few hundred
   MB at 15k) in main. Existing, the autosave does it every 15 s; the document writer adds nothing to it (§4.1).

## 2. Decisions in one table

| Question | Decided | Driven by |
|---|---|---|
| Container | A zip, **stored** entries only, zip64 when needed, `mimetype` first (ORA's convention) | PNG entries are compressed already; stored entries can be copied at disk speed and read by byte range; any zip tool opens it |
| Pixels in the file | The mirror's PNG files, copied byte for byte | They exist after the flush (`syncLayers`); nothing is encoded again |
| Where the file is written and read | The main process, streamed in 8 MB chunks | Renderer never holds the file; `saveFile`/`openImage` hold it whole (trap 6 aside) |
| Editor state | `getValue()` verbatim inside `scumble/document.json` | The autosave's proven shape; `setValue()` reads it |
| Dedupe | By mirror key within a file; by key + size + CRC-32 against the mirror on open | Hash-named files dedupe by content already; trap 3 |
| Collisions on open | Import under a free name and rewrite the refs | Trap 3 |
| Merged full-size picture for other apps | Not written; a 256 px thumbnail is | 6-10 s per save at 15k (`PLAN_BCE.md` 4004-4005); open question 4 |
| Undo history | Not saved | Not persisted today either; held as tile clones (`heldPixels`, `inpaint_canvas.js` 11764-11781) |
| Result history (Results list) | Saved with its files | It is the user's paid output; open question 2 |
| Write safety | Temporary file in the target folder, fsync, rename; a registry of temporaries swept at start | `autosave.writeJson`'s pattern; a kill leaves the old file whole |
| Quit during a save | The close and the update install wait for it (inside `QuitGuard.run`'s 120 s) | `quit.js` 33-49 |
| Plugin data | A per-document plugin store, saved in the autosave and the file | Trap 2 |
| Versioning | `version` + `minReader` in `document.json`; unknown things are carried, not dropped | §6 |
| Editor / node | One editor change (trap 1); the node gets nothing else | §6 |
| Ctrl+S | **Open question 1** | trap 4 |

## 3. The container

### 3.1 Layout

```
mimetype                                  "application/x-scumble", first entry, stored, no extra field
scumble/document.json                     the header, the editor state, plugin data (UTF-8, stored)
Thumbnails/thumbnail.png                  at most 256 px on the long side (ORA's name for it); optional
files/<type>/<subfolder>/<filename>       every mirror file the state names, e.g.
    files/input/inpaint_canvas/photo.png                      the base as it was opened
    files/input/inpaint_canvas/n3_layer_1a2b3c4d5e6f.png      a layer (name = its hash)
    files/input/inpaint_canvas/n3_lmask_....png               a layer mask
    files/output/inpaint_canvas/....png                       result history
    files/input/inpaint_canvas/fonts/MyFont.ttf               a font the user added
    files/input/inpaint_canvas/cube.glb                       a 3D model (glb plugin data)
```

The entry name is the mirror key (`type/subfolder/filename`, `files.js` 51-53, 23-28) under `files/`, so the mapping
both ways is a string operation, and a user who renames the file to `.zip` finds plain PNGs. The first 60 bytes
identify the format the way `isOra` does (`inpaint_layered.js` 42-49): a stored `mimetype` entry holding
`application/x-scumble`. The same MIME type goes into the Linux desktop entry (§5.6).

### 3.2 `scumble/document.json`

```json
{
  "format": "scumble", "version": 1, "minReader": 1,
  "app": "0.1.30", "saved": "2026-09-27T10:00:00+02:00",
  "summary": { "name": "portrait", "width": 15000, "height": 10000, "layers": 6 },
  "recipe": { "id": "flux2_klein_local", "provider": null },
  "document": { ...getValue() as an object... },
  "extra": { ...top-level fields of an opened newer document this app did not know... },
  "plugins": { "glb": { ...per-document plugin data... } },
  "files": [ { "entry": "files/input/inpaint_canvas/photo.png", "size": 123456789, "required": true } ]
}
```

- `document` is `JSON.parse(ed.getValue())`, unchanged. A save never edits the editor's JSON except for ref renames on
  open (§3.5).
- `recipe` is information: the recipe is global (`host.recipe`, `host.js` 181; selecting one changes every tab and is
  an ASK for the assistant, `policy.js` 116), so opening a document does not switch it; the status line says "saved
  with Flux.2 Klein local; the current recipe is ..." when they differ.
- `files` lists every entry with its size; `required` is false for result-history files only (§3.5). The zip's own
  CRC-32 covers integrity; `document.json` carries no hashes.
- `extra` carries top-level fields of `document` this app does not produce (§6).

### 3.3 What goes in, per kind of content

Everything below is already in `getValue()` (11898-11926) except the plugin data; the right column is what makes it
reopen editable.

| Content | In `document` as | Files packed |
|---|---|---|
| Canvas size, base | `width`, `height`, `base` (a ref) | the base PNG |
| Paint, image, result, text, shape pixels | `layers[]` with `kind`, `ref`, `x y w h`, opacity, blend, role, visible, locked, alphaLock. Shapes are raster in a paint layer (the shape tool draws into the active layer, `inpaint_canvas.js` 5230-5298) | each layer's PNG (its own size; `w`/`h` is its placement, so a scaled layer keeps its source pixels) |
| Layer masks | `layers[].mask` (a ref) | the mask PNG |
| Text layers | `layers[].text` (content, font, size, colour, outline, `fontRef`) plus the rendered `ref` | the rendered PNG; the font file when the user added one (`fontRef`, 8440-8466; open question 3). A system font is named only; a machine without it falls back and says so (8338) |
| Filter layers | `filter`, `params`, `lut` (a ref to the LUT as a PNG, 7535), `plate` (grain plate ref and stats, 7557), mask | LUT PNG, plate image, mask |
| Film plugin filters | the same, with a plugin filter id | as above; kept verbatim when the plugin is missing (trap 1) |
| Colour match | `layers[].match` | none |
| Reference and control layers | `role: "reference"` / `"control"` | their PNGs |
| 3D (glb) layers | a paint layer plus plugin data `{ ref, params, depthId }` per layer (§3.6) | the layer PNG, the depth layer PNG, the `.glb` / `.gltf` |
| EU AI label | a paint layer (`plugins/ailabel/main.js` 1-9) | its PNG |
| Selection | `selection` (a PNG data URL), `selectionBox` | none (inline) |
| Saved selections | `selections[]` (`{ name, url }`, data URLs, 4833) | none (inline) |
| Guides, crop, generation, prompt, negative, upsample, cutout, refs, recipe settings | `guides`, `crop`, `gen`, `prompt`, `negative`, `upsample`, `cutout`, `refs`, `settings` | none |
| Result history | `history[]` (100 at most, each with prompt, seed, mode, denoise and a ref, 9261-9262), `seen` | each result's file, `required: false` |
| Plugin data | `plugins` (§3.6) | every ref inside it |

The selection PNGs stay inline as data URLs in v1, as the autosave keeps them. If the 15k measurement finds
`document.json` above 64 MB, a later minor version moves them into entries; the reader of v1 already accepts both
(§6).

### 3.4 What stays out

- **Keys and the connection:** API keys live in the OS store (`keys.js`), the ComfyUI URL and auth in
  `settings.comfy` (`main.js` 645-656). Neither is in `getValue()`, and the writer reads only mirror files named by
  refs, so it cannot pick up anything else under `userData`.
- **Global settings:** node params and the highres mode (`host.js` 1431-1439, 217-222), the recipe choice, skins,
  brush library, plugin storage that is not per document (the film panel's group, the AI label's last settings).
- **Paths:** the mirror root, the folder an image was opened from (only its file name survives, as the base's mirror
  name - the file name is user content and stays), the document's own path, `lastSaveDir`. Recent files and the tab's
  path live in the user's settings and autosave, never in a document.
- **Session state:** other tabs, closed tabs, the undo and redo stacks, the upload cache (`uploaded`), assistant chats,
  the log, the view (zoom and pan are not in `getValue()`; could be an optional `view` field later).
- **What does go in and is worth saying:** prompts, negatives, seeds and the result history. A shared `.scumble` shows
  how a picture was made (open question 2).

### 3.5 Refs to entries and back

**Save.** Walk `document` and `plugins` with `walkRefs` (made to return the ref objects too, not only keys). For each
distinct key: resolve the file (`mirrorPath`, `files.js` 23-28). A file missing from the mirror is fetched through the
mirror's own view path when ComfyUI is connected (`handleView`, 167-187, which keeps a copy); otherwise the save stops
and names the file ("... is not in the local store and ComfyUI is not connected"), except for result-history files,
which are left out with their history entries and a note. A file is stored once however many refs name it (a result
layer and its history entry share one, 9253-9261; a duplicated layer shares its original's until it is edited).

**Open.** For each `files/` entry, after checking the name (below): compute the mirror path.
- Missing there: copy the entry to `<path>.importing-<pid>`, checking its CRC while copying, then rename into place.
- Present with the same size and the same CRC-32 (the file is read once for it, `zlib.crc32`): reuse it. Opening a
  document saved in this profile copies nothing.
- Present with other bytes: import under `freeName()` ("photo (1).png") and record the rename.
All renames are then applied to every ref object in `document` and `plugins` (same type and subfolder, old filename ->
new). The editor only ever sees refs to files that exist in this mirror with the saved bytes.

Validation before anything is written: an entry name must be exactly `files/` + a key that `mirrorPath` accepts (type
`input` / `output` / `temp`, no `..`, no absolute part, `SAFE_NAME`), so a crafted file cannot write outside the
mirror. Entries not listed in `files[]` are ignored. Pruning (`files.js` 225-251, Settings only) is refused while a
document is being saved or opened, and the keys a save is writing are added to its keep list.

### 3.6 Plugin data per document

A new plugin API: `scumble.documents.data(doc)` returns `{ get(), set(patch) }`, a JSON object per plugin **and per
document** (`renderer/plugins.js`, beside `storage`, 639-645; `API_VERSION` 16 goes to 2, `docs/PLUGINS.md`). The app
keeps it on the editor as `ed.pluginData = { [pluginId]: object }`; `set()` calls `host.changed(ed)` so the tab goes
dirty and the autosave follows. It is saved in the autosave bundle entry (`{ id, state, file, plugins }`, §5.2) and in
`document.json` `plugins`, and any ref inside it is packed and renamed like the state's. Data of a plugin that is not
installed or not enabled rides along unchanged: it is in the per-document map whether anyone reads it or not.

The glb plugin moves its `objects[layerId]` entries into the document's store and reads the global storage only as a
fallback for sessions from before (then moves the entry over). That also fixes a quiet bug of the global store: two
tabs with the same layer ids (a document opened from an earlier state twice) share one entry. The AI label's
session-only map (`plugins/ailabel/main.js` 27) could use it too; optional.

`autosave.referencedKeys` (`autosave.js` 150-164) and `host.referencedFileKeys` (`host.js` 1475-1488) walk
`plugins` (and the closed tabs, §5.4) as well, so pruning keeps those files.

## 4. Writing and reading at 15k

### 4.1 Save

1. **Target.** Save As, or a tab without a file: main's save dialog (`documents:choosePath`, default folder
   `settings.lastDocumentDir` or Documents, default name the tab's name + `.scumble`). Before any work, so a cancel
   costs nothing.
2. **Flush (renderer).** `saveBeforeRestart` is split so its body for one editor is `host.flushEditor(ed, say)`: wait
   for `_restoring`, wait while a pointer gesture is down (as `scheduleAutosave` does, `inpaint_canvas.js` 7483), up to
   three `syncLayers()` rounds, the selection encode wait. `saveBeforeRestart` keeps its behaviour by calling it per
   editor. The encode runs in the pool at EXPORT priority as today.
3. **Capture (renderer).** `state = ed.getValue()`, `plugins = ed.pluginData`, the thumbnail (`sampleRegionSettled`
   at 256 px; if it throws, the file has none). A stroke after this point is not in the file and leaves the tab dirty.
4. **Write (main).** `documents:write({ reqId, path, header, thumbnail })`. Main resolves the files (§3.5), checks free
   space, writes the temporary file, fsyncs, renames (§4.3), verifies the central directory against `files[]` (sizes,
   names; no second read of the data), adds the path to the recent files and answers `{ path, bytes, files, ms }`.
   Progress goes out as `documents:progress { reqId, done, total }` in bytes.
5. **Mark (renderer).** `ed.docFile = { path, name, key, mtime, size }` where `key` is a hash of the saved state string
   (§5.2); tab and title refresh.

**Memory ceiling.** Main: two 8 MB copy buffers per write, the central directory (under 100 bytes an entry) and
`document.json`. Renderer: nothing beyond the flush, which is the autosave's. **Band size:** there is none in the
container; the bands are where pixels are encoded (`writePng` parts of about 8 MB, unchanged). **Speed:** the write is
a sequential copy; a clean 15k document costs its file size at disk speed. The flush adds 0.78 s per dirty full 15k
layer (E2). These are expectations; §7's measurement decides.

Only one save per document at a time (a second Ctrl+S during one says "already saving"); two tabs may not write the
same path at once (a lock map in main).

### 4.2 Open

1. **Where from:** the Open dialog (`.scumble` joins the first filter of `IMAGE_FILTERS`, `main.js` 581; `openImage`
   routes a `.scumble` by extension or its first bytes to the document path instead of reading it), File > Open
   Recent, a drop on the window, a double click (argv, second instance), `open_document`.
2. **Already open:** a path open in a tab activates that tab (Windows: compared after `path.resolve`, case-folded).
3. **Read (main).** The end of the file for the EOCD (and the zip64 locator and record), the central directory, the
   `mimetype` entry, `document.json` (64 MB at most); the version rules (§6). Then the `files/` entries into the mirror
   (§3.5) with progress; a CRC mismatch stops the open and names the entry (entries imported before stay, valid, for
   pruning to find). Result: `{ header (refs rewritten), path, notes }`.
4. **Restore (renderer).** A new tab (or the active tab when it is empty), through `host.restore()` with a fresh id as
   `openGeneration` does, so `_restoring` holds the autosave; then `ed.pluginData`, `ed.docFile`, the `extra` fields,
   notes in the status line. `setValue()` streams the PNGs into tiles off the window as the autosave restore does.

Measured for comparison (E, `PLAN_BCE.md` 4011): the restore of a 30000 x 20000 document from the autosave state took
11.2 s wall, 91 ms blocked. An open is that plus the copy into the mirror (skipped for files already there).

The canvas backend opens what its restore opens today: every layer through an `<img>` (`setValue` 11951), so up to
Chromium's canvas limits. The tiles backend is the default and the 15k measurement runs on both (§7).

### 4.3 Temporary file, fsync, rename

- The temporary file sits beside the target (a rename across volumes fails): `<target>.saving-<pid>-<n>`. Its path is
  recorded in `<userData>/document-temps.json` before it is created and removed after the rename or the abort; at every
  start main deletes the listed files that still exist and match that name pattern (never any other file).
- Zip writing: the local header is written with the size (known from `stat`; a mirror file never changes under its
  name) and a CRC of zero, the data is copied in 8 MB chunks through `zlib.crc32` (Node 22+, Electron 44 here), and the
  CRC is written back into the header by a positional write. No data descriptors, so every zip reader takes it.
  Zip64 extra fields where a size or offset passes 0xFFFFFFFF, the zip64 end records when the directory does or when
  there are more than 65,535 entries.
- `filehandle.sync()`, close, then `fs.rename` over the target. On Windows a freshly written file is often held for a
  moment by a virus scanner or a sync client: EPERM / EBUSY / EACCES are retried for about 2 s, then the temporary file
  is deleted and the save fails with "the file is in use by another program".
- **Save in place checks the file first:** when the target's size or mtime differ from what `docFile` recorded at the
  open or the last save, the user is asked before it is overwritten ("changed on disk since you opened it").

### 4.4 Disk full, cancel, errors

- **Before writing:** `fs.statfs` of the target folder against the sum of the entry sizes plus 1 MB (the old file
  stays until the rename, so it is not counted as free). Refused up front: "portrait.scumble needs 2.8 GB and D: has
  1.1 GB free. The document is safe in the session."
- **During writing:** any error (ENOSPC included) closes the handle, deletes the temporary file, leaves the target as it
  was and says so in the status line. A test hook (`SCUMBLE_DOC_FAULT=enospc@<bytes>`, read in dev builds only)
  injects the failure for the gate.
- **Cancel:** a progress chip in the tab bar (the shell owns it, so no editor change) shows "Saving 43 %" with a cancel
  cross; `documents:cancel(reqId)` stops the copy loop, deletes the temporary file, leaves the target. Before the write
  starts, a cancel only stops the capture (the flush's uploads finish; they are the autosave's anyway).
- **Every failure** keeps the tab's `docFile` as it was, so the tab stays dirty.

### 4.5 Quit, update, crash, kill

- **A close during a save waits for it.** The renderer's flush answer (`app:flush`, `shell.js` 1917-1921) first awaits
  the document saves in flight (`host._docSaves`, the whole flow including the write request), then does what it does
  now. Main's close handler runs `quitGuard.run(async () => { const r = await flushWindow("quit"); await
  documents.idle(); return r; })`, so a write whose request arrived during the flush is waited for too. The update
  install (`main.js` 859-865) and View > Reload (339-347) get the same line. All inside the guard's 120 s.
- **"Quit now"** (the second close, `askWhileSaving`, 350-364) and the guard's timeout abort the writes: temporary
  files deleted in `will-quit`, targets untouched. The session keeps the latest state through the autosave; the tab
  comes back dirty.
- **A crashed renderer** (`render-process-gone`, 291-312) cancels its writes the same way; a reload restores the
  session.
- **A killed process** leaves the temporary file and the target as it was; the next start sweeps the temporary file
  (§4.3). The kill gate proves both (§7).
- **Closing a tab during its save** is "still working" (`busy()` in `shell.js` 134-136 gains `ed._docSaving`); closing
  anyway cancels the save.

### 4.6 Integrity and untrusted input

A `.scumble` from someone else is data. The reader checks the EOCD, entry offsets and sizes against the file length
(stored entries: no inflate, no zip bomb), entry names (§3.5), `document.json`'s size, and the types it hands on:
`selection` and `selections[].url` must be `data:image/png;base64,` strings or are dropped, refs go through
`mirrorPath` on import, plugin data goes only to the plugin that owns it. Numbers are clamped where `setValue` already
clamps; filter params pass as they do from the autosave (the flare note in `CLAUDE.md` item 21 says `applyParams`
assigns them raw; the filter code has to live with any value either way).

## 5. The UX

### 5.1 Menu and shortcuts

File menu (`main.js` 498-515) becomes: New Tab, Open... (images and documents), Open Recent >, Reopen Closed Tab
(Ctrl+Shift+T, free in the editor: the Ctrl check at 2259 returns before Shift+T at 2263), Save, Save As... (Ctrl+Shift+S),
Export Image... (today's "Save Image..."), Close Tab, then as now. The accelerators depend on **open question 1**:

- **Variant A, as Photoshop, Krita and GIMP:** Ctrl+S saves the document (Save As when the tab has no file), Ctrl+Shift+S
  is Save As, the picture export moves to **Ctrl+Shift+E** (GIMP's Export As). Costs: the shell takes Ctrl+S,
  Ctrl+Shift+S and Ctrl+Shift+E in a window capture listener registered before any editor (the editor's own listener,
  1983, is registered per tab later, so the shell's runs first and stops it); the editor source stays as it is, so the
  ComfyUI node keeps Ctrl+S for the picture and Ctrl+Shift+E for merge down (trap 4). The manual changes in four places
  (`docs/MANUAL.md` 84, 93, 240, 442); the user's habit of a year changes. Which of the menu accelerator and the
  page's handler fires for a key both claim is measured in D3, not assumed.
- **Variant B, as today:** Ctrl+S keeps saving the visible picture, Ctrl+Shift+S saves the document (Save As without
  a file), Save As has no key. Costs: none for habits; the dirty marker and "close asks to save" then refer to a key
  nobody presses by reflex.

The plan recommends A: the dirty marker (§5.2) is about the document, and the key that clears it should be the one
every other editor uses.

### 5.2 Tab name and the dirty marker

- The name is the file's stem when the tab has a file, else today's `docName` (base file name). Both copies of
  `docName` change (`shell.js` 129-132, `commands.js` 45-48). The tab's tooltip gets the path.
- **Dirty** = the tab has a picture and either no file, or a layer or mask is dirty (`l.dirty` / `l.maskDirty`), or the
  selection is not encoded yet, or the hash of `getValue()` differs from `docFile.key`. It is computed where the
  autosave already calls `getValue()` for every tab (`host.saveAll` -> `bundle()`, `host.js` 1454-1472, 1.5 s after a
  change), so it costs one string hash (a 53-bit hash of a string of a few MB is well under a millisecond per MB) and
  no extra `getValue()`. An undo back to the saved state makes the tab clean again once the layer is uploaded (the
  upload's name is its hash, so the ref is the saved one).
- The marker: a trailing "*" on the tab name (the busy dot "● " in front stays as it is, `shell.js` 156) and on the
  window title.
- The autosave bundle entry gains `file: { path, name, key, mtime, size }` and `plugins`; `host.restore()` puts them
  back, so a dirty tab is still dirty after a restart. The bundle stays `version: 2`: the fields are additive and an
  older app reads `id` and `state` only (`host.js` 714-724).

### 5.3 Close asks

`closeDocument` (`shell.js` 168-179) today confirms every close of a tab with a picture. New:
- clean tab with a file: closes without a question (the file holds it, and Ctrl+Shift+T brings it back);
- dirty tab or no file: main's `dialog.showMessageBox` with Save / Don't Save / Cancel ("Save changes to
  portrait.scumble?"; without a file "Save portrait as a document?"). Save runs §4.1 (Save As for no file) and closes
  after success; a failed or cancelled save keeps the tab;
- `force` (the `close_document` command, `commands.js` 327-331) skips the question as now.

**Quitting the app does not ask** (decided here, open question 5 for the user to overrule): 3a made quit wait for the
autosave, the next start restores every tab with its file path and its dirty marker, so nothing is lost.

### 5.4 Reopen a closed tab

A closed tab is hidden from the tab bar at once, then flushed (`syncLayers`, bounded like the quit), its state captured
(`getValue()`, `file`, `plugins`, name, time), then destroyed. The last 10 go into `host.closed`, which the autosave
bundle keeps as `closed: [...]` (so pruning keeps their files, §3.6). Ctrl+Shift+T / File > Reopen Closed Tab restores
the newest through `host.restore()` with a fresh id. The assistant's `close_document` reason ("there is no reopen",
`policy.js` 110) changes to name the reopen.

### 5.5 Recent files

Main owns `settings.recentDocuments` (10 entries: path, name, time), updated after every successful save and open;
File > Open Recent lists them with "Clear Recently Opened" (the menu is rebuilt, `buildMenu`, 484-555). A missing file is
removed from the list when it fails to open. `app.addRecentDocument(path)` feeds the Windows jump list (it only shows
there once the file type is registered, §5.6). The renderer never keeps its own copy (the settings-copy trap in
`CLAUDE.md`).

### 5.6 Double click, argv, drop

- **NSIS:** `build.fileAssociations` in `package.json`: `{ ext: "scumble", name: "Scumble document", role: "Editor",
  mimeType: "application/x-scumble", icon: "build/icon.ico" }` (the app icon until item 18's artwork has a document
  variant; open question 6). Per-user install (`nsis.perMachine: false`) registers it for the user.
- **MSIX:** a `uap:Extension Category="windows.fileTypeAssociation"` with `.scumble` beside the execution alias in
  `build/AppxManifest.xml` 47-53. A full-trust Store app gets the path on its command line; to be tested, as the
  single-instance pipe already is (`docs/STORE.md`).
- **Linux:** the same `fileAssociations` entry gives the .deb and AppImage desktop files the MIME type. Untested, as all
  of Linux (`docs/BUGS.md`).
- **macOS (B3):** `app.on("open-file")` when B3 is built; noted there, not here.
- **argv:** `documentArgs(argv)` in main: arguments that are not flags, not `.`, end in `.scumble` and exist as files
  (relative ones against `second-instance`'s working directory). A first start queues them; the renderer takes the
  queue (`documents:takePending`) after its restore (`shell.js` 2048-2056), so the session's tabs come back first and
  no restore races the open. A second instance (`main.js` 981 and 928) shows the window and pushes the paths
  (`documents:openRequest`). An agent start (`--mcp`, `--cmd`) never opens a document from argv.
- **Drop:** a `.scumble` dropped on the window is caught by the shell in the capture phase before the editor's drop
  handler (which would call `loadFile`, 9044); its path comes from `webUtils.getPathForFile` through the preload.
  The editor is not touched.
- **The known trap:** while the dev tree's headless MCP instance holds the default profile, a double click lands in it
  (`docs/BUGS.md` "A headless MCP instance can block the app from starting").

### 5.7 Commands, MCP and the assistant

- `save_document { doc, path?, copy? }`: without `path`, saves the tab to its file (an error when it has none: "pass
  path"); with `path` (must end in `.scumble`) it is Save As; `copy: true` writes the file without making it the tab's
  file (an agent's snapshot). Returns `{ path, bytes, files, ms }`.
- `open_document { path, activate? }` (app scope): opens a tab or activates the one holding the file; returns the
  document summary and the notes.
- `list_documents` / `docSummary` (`commands.js` 41-43) gain `file` (path or null) and `dirty`.
- `docs/COMMANDS.md` is regenerated (`python tools/commands_doc.py`); MCP gets the two tools from the table as always.
- **Policy** (`policy.js`): `save_document` REFUSEs without a path when the tab has no file (the dialog would hold the
  turn), REFUSEs a path not ending in `.scumble`, ASKs "writes a new file" / "overwrites <path>" with the path on the
  card, the in-place case included (the facts: `statFile`, and the tab's file from the summary). `open_document` ASKs
  "reads a file from your disk and opens it as a tab", like `load_image` with a path (88-92). `close_document`'s
  reason as in §5.4.

## 6. Versioning, and the node

- **`version`** is the format version the writer speaks; **`minReader`** the oldest reader version that shows the
  document without losing what it means. v1 writes 1 and 1.
- **An older app** (reader version below `minReader`) refuses: "portrait.scumble was saved by Scumble 0.2.3 (format 3);
  this Scumble reads format 1. Update Scumble to open it." Nothing is imported.
- **An app at or above `minReader` but below `version`** opens it, says "saved by a newer Scumble; parts it does not
  know are kept but not shown", and marks the tab `docFile.newer`: Save in place asks first and proposes Save As.
- **What v1 does with what it does not know:** top-level fields of `document` it does not produce go to `extra` and
  back into the next save; a layer of an unknown `kind` with a `ref` loads as a pixel layer (today's generic branch,
  `setValue` 12017-12039) and keeps its kind; one without a `ref` is dropped with a note (so a later format adding a
  kind without pixels, a group for instance, has to raise `minReader` or give it a baked `ref`); an unknown filter id
  is kept with its params and passes the picture through (trap 1); plugin data of unknown plugins rides along (§3.6).
  Unknown fields inside a layer are lost on the next save (`getValue()` rebuilds the layers): the rule for later
  writers is that a field which changes the picture raises `minReader`.
- **The ComfyUI node** needs none of the format: its document is the workflow's `canvas_state` widget, and every piece
  of the format lives in the app (`electron/main/`, `renderer/shell.js`, `renderer/editor/host.js` which is app-only,
  `renderer/plugins.js`). The one editor change is trap 1's fix in `setValue` (and the layer panel's type select
  showing "missing: <id>" instead of grain, 9546-9552); it is right for the node too. `python tools/build_node.py
  --check` and `nodecopy` run in D2; the node repo is built only when a node version is meant to ship
  (`CLAUDE.md` "The node repo is behind").

## 7. The build: steps, gates, estimates

Every step ends in a local commit (`git -c user.name=DenRakEiw ...`, no Claude trailer). Estimates are working days
and **estimates**.

### D1. The container in plain Node (1.5 to 2 d)

`electron/main/docfile.js` (no electron import, like `quit.js`): the stored-zip writer (positional CRC, zip64), the
directory reader (zip64), entry copy with CRC check, `document.json` build and validation, the version rules, ref walk
and rename (`walkRefs` extended), the mirror import (dedupe, `freeName`, `.importing` rename), name validation, the temp
registry and sweep, the free-space check, the fault hook. `tools/document_test.js`: round trips on a scratch mirror;
zip64 with the thresholds lowered by a test switch, and one real case above 4 GiB behind `--big` (a sparse input file);
every written file read back by Python's `zipfile.testzip()` as an independent reader; truncated files, bad CRCs,
`../` and absolute entry names, a directory past the file end, a newer `minReader`; ENOSPC and EBUSY injected into a
fake fs; the sweep never deleting a file that does not match its pattern.

**D1 built 2026-09-26** (`electron/main/docfile.js`, `tools/document_test.js`, 11 checks plus `--big`, every file read
back by Python's zipfile too). The temp registry, the sweep and the free-space check are in the module; main calls
them in D2. The 4 GiB case wrote 4.00 GiB in 3.2 s (a sparse source, so the read is nearly free; the real speed is
D5's measurement).

### D2. Save and open in the app (2.5 to 3.5 d)

Main: IPC `documents:choosePath / write / open / cancel / progress / takePending`, the lock map, the quit and update
and reload holds, `will-quit` cleanup, `openImage` routing, pruning refused while busy. Renderer: `host.flushEditor`
split out of `saveBeforeRestart`, `host.saveDocument(ed, { as, copy, path })`, `host.openDocument(path)`,
`ed.pluginData` and `ed.docFile` in `bundle()` / `restore()` and the walkers, `scumble.documents.data` in
`renderer/plugins.js`, the glb plugin moved onto it, trap 1's fix in `setValue`, the menu entries (with the
accelerators of whichever variant the user picked; B until then). `build_node.py --check`, `nodecopy`, `lint`, `types`.

**D2 built 2026-09-26** (local, not pushed). Main: `electron/main/documents.js` (plain Node: the job per request, the
lock per path, cancel, `idle()`, `abortAll()`, the pending queue, `documentArgs` for D4, the selection fields of an
opened file checked, a history file that is gone leaves its entry out with a note, a missing required file refuses
the save), IPC `documents:choosePath / write / open / cancel / takePending / stat` and `documents:progress` /
`documents:openRequest`, the close, the update install and View > Reload wait for `documents.idle()` inside the
guard, "Quit now" and a crashed renderer abort, `will-quit` sweeps, the start sweeps, pruning is refused while a job
runs and keeps the jobs' keys, Open routes a `.scumble` (by name or first bytes) to the document path, the File menu
is variant A (Save Ctrl+S, Save As Ctrl+Shift+S, Export Image Ctrl+Shift+E). Renderer: `host.flushEditor` is a
sibling of `saveBeforeRestart` with the same steps for one editor (the 3a function is untouched, so the quit gate
keeps testing what it tested; an upload that fails throws here), `host.saveDocument` / `openDocument` /
`documentProgress` / `docSavesIdle`, `docFile` / `pluginData` / `docExtra` in `bundle()` and `restore()`, the
walkers (`referencedFileKeys`, `autosave.referencedKeys`) read `plugins`, the flush answer waits for the saves in
flight, a shell capture listener takes Ctrl+S, Ctrl+Shift+S and Ctrl+Shift+E before the editor. Plugin API 2:
`documents.data(doc)`; the glb plugin keeps its objects there (the global store is read once as a fallback and the
entry moved). Trap 1: `setValue` keeps an unknown filter id and its params, the panel shows "missing: <id>", reach
counts it as 0, `set_filter` on it says why it refuses. **Checked in the app** (a scratch profile, `--no-comfy`, not
a gate yet): a round trip with a text layer, a filter layer, a selection and plugin data (state equal, `zipfile`
testzip clean); a painted layer is uploaded before the write; a second save during one is refused; a cancel leaves
the file and the tab's key; the tab's file survives a restart; a 3D object and an unknown filter id round-trip and
`glb.edit` works on the reopened file. **Measured on the way:** a Ctrl+S and a Ctrl+Shift+E sent through CDP's input
pipeline fired once each (the capture listener's `preventDefault` kept the menu accelerators from firing a second
time); a real keyboard is D3's check. **Left for D3:** the Save As switch for the history, recent files, the tab
name and dirty marker, the drop, closed tabs in the walkers.

### D3. Document UX (1.5 to 2.5 d)

Tab name and tooltip, the dirty marker and title, the close question, reopen closed tab, recent files and the jump
list, a file already open activates its tab, "changed on disk", the progress chip with cancel, the shortcut variant
(and the measurement of which handler fires for a doubly claimed key), the drop of a `.scumble`, the manual
(`docs/MANUAL.md`: Save, Open, Recent, Reopen, double click; the shortcut table).

**D3 built 2026-09-26** (local, not pushed). The tab shows the file's stem (`host.documentName`, used by the shell and
`commands.js`), the path in its tooltip, a " *" when `host.documentDirty` says so, and the window title follows
(`app:title`, main composes it with the agents line). Dirty = a picture and no file, an edited layer or mask not
uploaded, a selection not encoded, a change since the last autosave (`host.changed` drops `_stateKey`), or the
autosaved state's hash not the file's; `bundle()` computes the hash where it calls `getValue()` anyway and stores
`file.clean`, so a restart (and an open, `settleKey`) takes the restored state as the saved one once its selection
is re-encoded: a clean tab stays clean across a restart even where the state serialises a little differently. The
close asks Save / Don't Save / Cancel in main's dialog (`documents:ask`, behind `host.askDocument` so a test can
answer); a clean tab with a file closes silently. Every closed tab goes on `host.closed` (10, in the bundle as
`closed`, walked by both ref walkers) first as it is, then again after its layers are uploaded (30 s at most); File >
Reopen Closed Tab (Ctrl+Shift+T, a menu accelerator; the editor leaves the key alone) restores the newest. Save in
place asks when the file's size or mtime moved (`changed`) or a newer Scumble made it (`newer`); a Save As of a
document with results asks with or without the history (buttons, not a checkbox: the native save dialog has no
custom controls on Windows), and the tab's file remembers "without" for the next Ctrl+S. File > Open Recent (10,
main's `settings.recentDocuments`, `app.addRecentDocument`; a file that is gone leaves the list when it fails to
open). A `.scumble` dropped on the window opens (a capture listener before the editor's, the path through
`webUtils.getPathForFile`). The tab shows a progress chip with a cancel cross during a save or an open. Opening a
document saved with another recipe says so. `list_documents` has `file` and `dirty`; `close_document`'s policy
reason names the reopen. The manual has a chapter "Documents" and the new keys. **Checked in the app** (scratch
profile, `--no-comfy`): dirty after a change, clean after Save and after an undo back; a clean tab closes without a
question and reopens clean with its file; a dirty one asks, Cancel keeps it, Don't Save closes it and it reopens
dirty; the history question on Save As, remembered by Ctrl+S; the changed-on-disk question; after a restart a dirty
tab is still dirty and a clean one still clean, title "d3b * - Scumble"; Open Recent lists both files; a real file
drop through CDP's drag events opens the document; the chip during an 80 MB save (5000 x 4000 noise, 0.9 s). **Not
checked:** a key pressed on a real keyboard (CDP input only); the chip's look by eye.

### D4. Double click and commands (1 to 2 d)

`fileAssociations`, the MSIX extension, argv on the first start and from the second instance, the pending queue,
`save_document` / `open_document`, `docSummary`, the policy rows and `tools/assistant_test.js` cases for them,
`docs/COMMANDS.md`, `docs/PLUGINS.md` (the new API), the format's spec as `docs/DOCUMENTS.md` (this plan's §3 and §6
as built). Checking a real double click needs an installed build, which registers `.scumble` on this machine: only on
the user's word (open question 7).

**D4 built 2026-09-26** (local, not pushed). `build.fileAssociations` in `package.json` (NSIS: `.scumble`, "Scumble
document", `application/x-scumble`, `build/icon.ico`) and a `windows.fileTypeAssociation` in `build/AppxManifest.xml`.
A first start queues the `.scumble` paths of its command line (`documentArgs`), a second start (`onSecondInstance`,
in both lock holders: the window app and an agent-started headless one) shows the window and queues its paths with a
`documents:pending` nudge; the window takes the queue once its session is restored and the recipe chosen, and a nudge
before that is left for the start to take. `save_document { doc, path?, copy?, history? }` (no dialogs: `ask: false`)
and `open_document { path, activate? }` (app scope; waits until the tab's key has settled, so a `list_documents`
right after reads it clean); the assistant's policy refuses a save without a file or a path, a path not ending in
`.scumble` and a copy without a path, asks every save with the file and "overwrites" on the card (the in-place case
included, the tab's file read from `list_documents`), asks every open; `tools/assistant_test.js` has the row.
`docs/COMMANDS.md` regenerated (75 commands). **Checked in the app:** the command errors, a Save As, a copy that
leaves the tab's file, a save in place, an open of a file already open (activates) and of another (`activate: false`
keeps the active tab); a second start with a path opens it in the running instance and exits at once; a first start
with a path restores the session first, then opens the file. **Not checked:** a double click in Explorer (needs an
installed build), the MSIX manifest in a packaged build (`npm run dist:store`).

### D5. The full tier (2 to 3 d)

**`tools/document_test.py`** (app gate `document`, in `tools/run_gates.sh`; like `quit_test.py` it starts and ends its
own instances with their own profiles, `--offline`), on both backends:

1. `every_kind_round_trips` - one document with a base, a paint layer with strokes, an image layer placed smaller than
   its pixels, a result layer from the loopback provider with a mask and colour match, a text layer in a user font
   (a font from `renderer/editor/fonts/` added as a user font), a shape, filter layers (curves, grain with a plate, a
   LUT from a `.cube`), a film filter, a reference and a control layer, a 3D layer (`glb.place` with `glb_test.py`'s
   `cube_glb()`), the AI label, a hidden, a locked and an alpha-locked layer, blend modes, a feathered selection, two
   saved selections, guides, crop, prompt, negative, generation and recipe settings, a result history. Save, close,
   open: `getValue()` equal after the refs are mapped by their bytes, every layer's and mask's pixels byte-equal
   (hashes of `readRect`), the selection and saved selections equal, the whole flatten equal, `glb.info` equal and
   `glb.edit` working;
2. `opens_in_a_fresh_profile` - the same file in a second instance with an empty profile: the same bytes, `glb.edit`
   works (the file is self-contained);
3. `reopen_copies_nothing` - opening it again in the first profile adds no file to the mirror;
4. `a_colliding_name_is_renamed` - a different picture under the base's mirror name: the open renames, both documents
   keep their own pixels; one case with the **same size and other bytes** (a size-only dedupe would pass the rest);
5. `a_save_in_place_is_atomic` - the old file read while the new one is written: every read gives the old bytes until
   the rename, then the new;
6. `cancel_and_disk_full_leave_the_old_file` - cancel mid-write and the ENOSPC hook: target unchanged, no temporary
   file, the tab still dirty;
7. `a_kill_mid_save_keeps_the_old_file` - the process killed (`taskkill /F`) while the temporary file grows: the target
   byte-identical, the next start deletes the temporary file and restores the session;
8. `a_close_waits_for_the_save` - WM_CLOSE during a save: the process ends after the rename, the file opens;
9. `dirty_clean_undo` - dirty after a stroke, clean after Save, dirty again after a stroke, clean after undo and the
   upload; dirty survives a restart;
10. `close_asks_and_reopen` - the question for a dirty tab (answered through the dialog hook the quit gate uses),
    no question for a clean one, Ctrl+Shift+T brings it back with the same pixels;
11. `newer_documents` - a `minReader: 2` file refused with nothing imported; a `version: 2, minReader: 1` file with an
    unknown kind, an unknown filter id, an unknown top-level field and unknown plugin data: opened, noted, and all four
    back unchanged in the next save;
12. `commands_and_argv` - `save_document` / `open_document` through the command core and `mcp_test.py`, the policy
    answers, a second instance started with a path opens it in the running one.

**The 15k measurement** (`document:15000x10000`, tiles on and off): a base of noise (so the PNG is large, as a photo's
is) and three full-size paint layers with strokes plus a filter layer, as `perf_test.py` builds its stack. Recorded:
the flush and the write separately, MB/s, file size, the open (import and restore until settled), main's private bytes
(`app:metrics`) and the writer's own buffer counter, which must stay at or under 32 MB. The file must pass
`zipfile.testzip()`. Expected from §4.1, to be believed only when measured: a clean Ctrl+S at disk speed plus under a
second of work; the open within 10 % of the restore of the same document plus the copy.

**The mutation round** (each against a fresh instance, `CLAUDE.md` "Testing and benchmarking"): writing straight onto
the target instead of the temporary file (7); no CRC written back (`testzip`, 1); a zip64 boundary off by one (D1);
dedupe by size only (4); refs not renamed after an import (4); `getValue()` before the flush (1: the last stroke
missing); no wait for the selection encode above 16 MP (the 15k run with a selection changed right before the save);
the close not waiting (8); no sweep at start (7); the unknown filter back to grain (11); masks or plugin refs not
walked (1, 2); the dirty key taken before the flush (9). Each must fail its step; the untouched tree must pass first.

**Estimate for 3b: 8.5 to 13 working days** (D1 1.5-2, D2 2.5-3.5, D3 1.5-2.5, D4 1-2, D5 2-3), more than the share
of package 3's 14 to 24 days the review had in mind for it; the full tier and the kill and collision cases are most of
the difference.

## 8. Not in this package

- The history panel (3c), TIFF (3d), editable PSD masks (3e), the metadata switch for PNG exports (3f).
- Incremental saves (only the changed entries): a full rewrite is atomic and simple; revisit if the 15k Ctrl+S is too
  slow.
- Streaming `handleRawUpload`'s body to disk instead of one Buffer (`files.js` 119): would lower main's peak during
  every autosave upload too; a small fix of its own.
- A Windows thumbnail handler for Explorer, a start screen with recent documents: the thumbnail entry makes both
  possible later.
- Opening a `.scumble` in the ComfyUI node.

## 9. Answered by the user (2026-09-26)

- **Ctrl+S saves the document** (variant A): Ctrl+Shift+S is Save As, Ctrl+Shift+E exports the picture; the editor's
  Ctrl+Shift+E (merge down, it ignores Shift today) moves in the app only, the node keeps it.
- **The result history goes in the file**, with a switch in Save As to leave it (and the earlier prompts) out.
- **Fonts the user added travel in the file.**
- **No question on quit**: the session keeps unsaved documents, marked unsaved.
- Taken as proposed without asking: no full-size merged picture in the file; the app icon as the file icon for now;
  the double-click test with an installed build when the user says so.

## 9a. The questions as they were asked

1. **Ctrl+S:** variant A (Ctrl+S saves the document, Ctrl+Shift+S Save As, Ctrl+Shift+E exports the picture - the
   plan's recommendation) or variant B (Ctrl+S keeps exporting the picture, Ctrl+Shift+S saves the document). §5.1 has
   both variants' costs.
2. **The result history in the file:** all its files (up to 100 results, proposed), or a switch in Save As to leave
   the history - and with it the prompts of earlier runs - out, for sharing.
3. **Fonts the user added** travel in the file (proposed: a text layer then re-renders anywhere; some font licences
   forbid passing the file on), or stay out and fall back like a missing system font.
4. **A full-size merged picture** inside the file for other programs (+6 to 10 s per save at 15k): off, as proposed,
   or a setting.
5. **Quit with unsaved documents:** no question, as proposed (the session keeps them, marked unsaved), or a question
   per document as in Photoshop.
6. **The file icon:** the app icon for now, or a document variant from the logo work (item 18).
7. **Testing the double click** needs an installed build on this machine (it registers `.scumble` for your user):
   when and whether.
