# The `.scumble` document format

The file Scumble writes on *File › Save* and reads on *File › Open*, as built in package 3b (steps D1 to D3,
2026-09-26). The design and its reasons are `docs/PLAN_DOCUMENTS.md`; where the plan and the code differ, this file
follows the code and §9 lists the differences. Written for someone who writes a tool that reads or writes `.scumble`
files, and for a later Scumble developer who changes the format.

| Code | What |
|---|---|
| `electron/main/docfile.js` | the container: writer, reader, version rules, entry names, temporary files (plain Node) |
| `electron/main/documents.js` | the app service in main: what a save packs, which files are required, one job per path, cancel, what an open cleans |
| `renderer/editor/host.js` | `saveDocument`, `openDocument`, `STATE_KEYS`, the tab's file (`docFile`), plugin data, extra fields, the dirty marker |
| `renderer/plugins.js` | `scumble.documents.data(doc)`, plugin API 2 |
| `tools/document_test.js` | plain-Node checks of the container; every file it writes is read back by Python's `zipfile` too |

## 1. What it is

A `.scumble` file is one document (one tab) that reopens fully editable: the editor's state JSON (every layer, mask,
filter, text, selection, prompt and setting; the same JSON the session autosave keeps per tab) plus a byte-for-byte
copy of every file that state names in the local file mirror (`<userData>/files/`: the layer PNGs, and also fonts the
user added and 3D models). A save encodes no pixels; it copies the PNGs the editor already uploaded. The container is a
plain zip of stored entries, so any zip tool lists it and a copy renamed to `.zip` shows its PNGs.

| | |
|---|---|
| Extension | `.scumble` (compared case-insensitively) |
| MIME type | `application/x-scumble` |
| Container | zip, stored entries only (method 0), zip64 where a size, an offset or the entry count needs it |
| Recognised by | the extension (drop, command line, commands); *File › Open* also by the first bytes, for a renamed file: a local header at offset 0 whose name (bytes 30-37) is `mimetype` and whose data (from byte 38) is `application/x-scumble` (`docfile.isScumble`) |

Where the app uses it: *File › Save* (Ctrl+S; Save As when the tab has no file), *Save As...* (Ctrl+Shift+S), *Open...*,
*Open Recent*, a file dropped on the window; the double click (the file association and the command line) and the
commands `save_document` / `open_document` are step D4. The picture export is *Export Image...* (Ctrl+Shift+E). The
ComfyUI node neither reads nor writes the format.

## 2. The container

### 2.1 Entries

```
mimetype                               "application/x-scumble" (21 bytes, ASCII, no newline)
scumble/document.json                  the header with the editor state (§3)
Thumbnails/thumbnail.png               optional: the picture, at most 256 px on its long side
files/<type>/<subfolder>/<filename>    every mirror file the state and the plugin data name, e.g.
    files/input/inpaint_canvas/photo.png                    the base as it was opened
    files/input/inpaint_canvas/n3_layer_1a2b3c4d5e6f.png    a layer (named by its hash)
    files/output/inpaint_canvas/result_00012_.png           a result (history)
    files/input/inpaint_canvas/fonts/MyFont.ttf             a font the user added
    files/input/inpaint_canvas/cube.glb                     a 3D model (plugin data)
```

The writer's order is `mimetype`, `scumble/document.json`, the thumbnail when there is one, then the files in the order
of `files[]` in the header. A reader depends only on the first: `mimetype` must be the first entry of the central
directory. Scumble's reader ignores every entry that `files[]` does not list (other than the three above).

### 2.2 How each entry is written

| Field | Value |
|---|---|
| Method | 0 (stored) on every entry; compressed size = uncompressed size |
| Flags | `0x0800` (UTF-8 name) on every entry except `mimetype`, which has 0 |
| `mimetype` | first, stored, no extra field, flags 0 (the ORA / ODF convention, so the first 59 bytes identify the file) |
| CRC-32 | written as 0 into the local header first; the real value is written back at `offset + 14` once the data is copied, and into the central header |
| Data descriptors | none (flag bit 3 is never set) |
| Time and date | the save's local time in DOS format, the same on every entry (years before 1980 as 1980) |
| Version needed | 20; 45 on a local header with a zip64 extra field and on a central header with zip64 fields |
| Version made by | 45 (host 0) |
| Extra fields | only the zip64 one (`0x0001`), where §2.3 needs it |
| Comments, attributes, disk numbers | empty / 0 |

### 2.3 Zip64, as the writer applies it

"Reaches" means `>=`: 0xFFFF and 0xFFFFFFFF are themselves the escape values.

| Where | When | What |
|---|---|---|
| Local header | the entry's size reaches 0xFFFFFFFF | both size fields 0xFFFFFFFF, version needed 45, extra `0x0001` of 16 bytes: uncompressed size, compressed size (8 bytes each) |
| Central header | the size reaches 0xFFFFFFFF, or the local header's offset does | those fields 0xFFFFFFFF; extra `0x0001` with the 8-byte values in the order uncompressed size and compressed size (only when the size needs them), offset (only when it needs it); version needed 45 |
| End records | the entry count reaches 0xFFFF, or the central directory's size or offset reaches 0xFFFFFFFF | the zip64 end of central directory record (56 bytes: record size 44, versions 45 / 45, disks 0, entry counts, directory size, directory offset), the zip64 locator (disk 0, the record's offset = directory offset + size, 1 disk), then the classic end record with **all** of its count, size and offset fields set to 0xFFFF / 0xFFFFFFFF |

Without any of these the file is a classic zip with a 22-byte end record and no comment. `tools/document_test.js` takes
every zip64 path with the thresholds lowered (`docfile.setLimits`) and writes one real file above 4 GiB behind `--big`.

## 3. `scumble/document.json`

UTF-8 JSON without a BOM (the reader does not strip one), compact, at most 64 MiB: the writer refuses a larger header
and so does the reader.

| Field | Type | Meaning |
|---|---|---|
| `format` | string | always `"scumble"` |
| `version` | integer >= 1 | the format version the writer speaks; this app writes `1` (`FORMAT_VERSION`) |
| `minReader` | integer | the oldest reader version that shows the document without losing what it means; this app writes `1`; missing = `version` |
| `app` | string | the writing app's version, e.g. `"0.1.30"`; named in the notes of a newer document |
| `saved` | string | the save time, ISO 8601 in UTC (`Date.toISOString()`, ends in `Z`) |
| `summary` | object | information only: `{ name, width, height, layers }` (the tab's name at the save, the canvas size, the layer count) |
| `recipe` | object or null | information only: the recipe selected at the save, `{ id, provider }` (`provider` null for a ComfyUI recipe). Opening does not switch the recipe (it is global); the notes say when they differ |
| `document` | object | the editor state (§4) |
| `extra` | object | the top-level fields of `document` this app did not know, carried from an opened newer document (§6.4); `{}` normally |
| `plugins` | object | per-document plugin data, `{ [pluginId]: object }` (§5) |
| `files` | array | one item per `files/` entry, `{ entry, size, required }` |
| `files[].entry` | string | the zip entry name |
| `files[].size` | integer | its size in bytes; must equal the central directory's |
| `files[].required` | boolean | false for a file that only the result history (`document.history`) names, true for every other; missing = true |

The zip's CRC-32s cover integrity; the header carries no hashes. An example (shortened: the settings objects and the
filter's params hold more keys in a real file):

```json
{
  "format": "scumble", "version": 1, "minReader": 1,
  "app": "0.1.30", "saved": "2026-09-27T08:00:00.000Z",
  "summary": { "name": "portrait", "width": 1200, "height": 800, "layers": 2 },
  "recipe": { "id": "flux2_klein_local", "provider": null },
  "document": {
    "width": 1200, "height": 800,
    "base": { "filename": "portrait.png", "subfolder": "inpaint_canvas", "type": "input" },
    "prompt": "a red scarf", "negative": "",
    "layers": [
      { "id": "Lmg1x2k01", "name": "Result 1", "kind": "result", "role": "none", "blend": "normal",
        "ref": { "filename": "result_00012_.png", "subfolder": "inpaint_canvas", "type": "output" },
        "x": 310, "y": 420, "w": 512, "h": 384, "opacity": 1, "visible": true,
        "mask": { "filename": "n3_lmask_9f8e7d6c5b4a.png", "subfolder": "inpaint_canvas", "type": "input" },
        "match": { "strength": 0.6, "source": "surroundings" } },
      { "id": "Lmg1x3a12", "name": "Grain", "kind": "filter", "role": "none", "blend": "normal", "ref": null,
        "x": 0, "y": 0, "w": 1200, "h": 800, "opacity": 1, "visible": true, "mask": null,
        "filter": "grain", "params": { "amount": 25, "size": 1.5 }, "lut": null, "plate": null }
    ],
    "history": [
      { "key": "r12", "name": "result_00012_.png",
        "ref": { "filename": "result_00012_.png", "subfolder": "inpaint_canvas", "type": "output" },
        "x": 310, "y": 420, "w": 512, "h": 384, "prompt": "a red scarf", "layerId": "Lmg1x2k01",
        "time": 1790488800000, "seed": 42, "mode": "api", "denoise": 1 }
    ],
    "selection": "data:image/png;base64,iVBORw0KGgo...",
    "selections": [], "seen": ["r12"],
    "crop": { "context": "auto", "feather": "auto" }, "upsample": { "useCase": "auto", "backend": "auto" },
    "gen": { "mode": "api", "denoise": 1, "seed": 42, "seedRandom": true, "refine": false },
    "settings": {}, "refs": { "fit": "pad" }, "cutout": { "backend": "auto" }
  },
  "extra": {},
  "plugins": {},
  "files": [
    { "entry": "files/input/inpaint_canvas/portrait.png", "size": 1843211, "required": true },
    { "entry": "files/output/inpaint_canvas/result_00012_.png", "size": 402113, "required": true },
    { "entry": "files/input/inpaint_canvas/n3_lmask_9f8e7d6c5b4a.png", "size": 5120, "required": true }
  ]
}
```

The result file is `required: true` here because the result layer names it too; with that layer deleted, only the
history entry would name it and it would be `false`.

## 4. `document`: the editor state

`document` is `JSON.parse(editor.getValue())` (`renderer/editor/inpaint_canvas.js`), unchanged; an open hands it to
`setValue()`, the session restore's path. Its top-level fields are the `STATE_KEYS` in `host.js`:

| Field | Type | What |
|---|---|---|
| `width`, `height` | integers | the canvas size in pixels |
| `base` | ref | the picture the document started from. Required: a save refuses a state without it, and an open without it leaves the tab empty |
| `prompt`, `negative` | strings | the prompt and the negative prompt |
| `layers` | array | the layers, bottom to top (§4.1) |
| `history` | array | the result history, the newest 100: `{ key, name, ref, x, y, w, h, prompt, layerId, time, seed, mode, denoise }` |
| `seen` | array of strings | the history keys already looked at, the newest 200 |
| `selection` | string or null | the selection mask as a PNG data URL (`data:image/png;base64,...`) |
| `selectionBox` | `[x, y, w, h]` | only when the selection PNG holds a box of the mask instead of the whole canvas: where the box goes |
| `selections` | array | the saved selections, `{ name, url }`, `url` a PNG data URL |
| `guides` | `{ x: [], y: [] }` | guide positions in pixels; left out when there are none |
| `crop`, `upsample`, `gen`, `settings`, `refs`, `cutout` | objects | the crop, prompt upsampling, generation, recipe *Settings* panel, reference-image (`{ fit }`, not file refs) and cut-out settings |

### 4.1 Layers

| Field | On | What |
|---|---|---|
| `id`, `name` | every layer | the layer id (a string such as `"Lmg1x2k01"`, unique in the document; plugin data keys on it) and the shown name |
| `kind` | every layer | `paint`, `image`, `result`, `text`, `filter`. Shapes are pixels drawn into an existing layer; the AI label and 3D renders are paint layers |
| `role` | every layer | `none` (part of the picture), `reference`, or a control type: `scribble`, `lineart`, `depth`, `pose`, `canny`, `other` |
| `blend` | every layer | `normal`, `multiply`, `screen`, `overlay`, `darken`, `lighten`, `soft-light`, `hard-light`, `difference` |
| `ref` | every layer | the layer's pixels, a PNG at its own size; `null` on a filter layer |
| `x`, `y`, `w`, `h` | every layer | the placement in canvas pixels; `w` / `h` may differ from the PNG's size (a scaled layer keeps its source pixels) |
| `opacity`, `visible` | every layer | 0 to 1; boolean |
| `mask` | every layer | the layer mask as a ref (a PNG), or `null` |
| `match` | when on | colour match `{ strength, source }`, `source` `surroundings` or `underneath`; left out at strength 0 |
| `locked`, `alphaLock` | when true | left out when false |
| `filter`, `params`, `lut`, `plate` | filter | the filter type id (built-in, or `<plugin>.<id>`), its parameters, a LUT `{ name, size, ref }` (the LUT stored as a PNG) or `null`, a grain plate `{ name, ref, w, h, mean, std }` or `null` |
| `text` | text | the description `{ content, font, fontRef, size, color, bold, italic, align, lineHeight, letterSpacing, outline, outlineColor, res }`; the rendered pixels are the layer's `ref`. `fontRef` is a ref to a font the user added, `null` for a bundled or system font (named only; a machine without it falls back) |

### 4.2 Refs and entry names

A ref is `{ filename, subfolder, type }`: `type` one of `input`, `output`, `temp` (missing = `input`), `subfolder` a
`/`-separated path (missing = `""`). It names a file in the local mirror, and in the file a `files/` entry. The refs of
the state are `base`, `layers[].ref`, `layers[].mask`, `layers[].lut.ref`, `layers[].plate.ref`,
`layers[].text.fontRef` and `history[].ref`; the plugin data (§5) and an opened newer document's unknown fields may hold
more. The walker (`docfile.collectRefs`) takes **every object with a string `filename`** anywhere in `document` and
`plugins` for a ref, so a key named `filename` must always mean a file.

| Direction | Rule |
|---|---|
| ref -> entry | `files/` + `type` + `/` + the subfolder's parts (backslashes read as `/`, empty parts dropped) + `/` + `filename`: `{ filename: "a.ttf", subfolder: "inpaint_canvas/fonts", type: "input" }` -> `files/input/inpaint_canvas/fonts/a.ttf` |
| entry -> ref | split at `/`: the second part is `type`, the last `filename`, the parts between, joined by `/`, the `subfolder` (`""` for `files/input/a.png`) |
| ref -> mirror key | `type/subfolder/filename` (`input/inpaint_canvas/a.png`; `input//a.png` without a subfolder): the unit of dedupe and rename |

A file is stored once however many refs name it (a result layer and its history entry share one; a duplicated layer
shares its original's until it is edited).

## 5. Plugin data per document

Plugin API 2 (`renderer/plugins.js`, `docs/PLUGINS.md`): `scumble.documents.data(doc)` returns `{ get(), set(patch) }`
for the calling plugin and one document. `get()` returns a copy of the plugin's object (`{}` when it has none);
`set(patch)` merges the patch shallowly (a key set to `undefined` goes), stores a JSON copy and marks the document
changed, so the autosave and the dirty marker follow. The app keeps the map on the editor as
`pluginData = { [pluginId]: object }`, saves it in the session autosave (the bundle entry's `plugins`) and in
`document.json` as `plugins`. A plugin reaches only its own key.

- **Refs inside plugin data** are packed like the state's (always `required: true`), renamed on open like the state's
  (§6.3), and kept by the mirror's clean-up (both ref walkers, `host.referencedFileKeys` and
  `autosave.referencedKeys`, read `plugins`).
- **Data of a plugin that is not installed or not enabled** rides along unchanged: it stays in the map whether anyone
  reads it or not.
- **Only the files a ref names travel.** The 3D plugin (`plugins/glb/main.js`) keeps
  `{ objects: { [layerId]: { ref, name, params, depthId } } }`, `ref` the `.glb` / `.gltf` file and `depthId` its depth
  layer; a `.gltf` with external buffers or textures carries only the `.gltf` itself. Sessions from before API 2 kept
  these objects in the plugin's global storage; the plugin reads that once as a fallback and moves the entry into the
  document.

## 6. Reading

The main process reads (`docfile.openDocument`, called by `documents.open`), streamed; the window never holds the file.

### 6.1 Container checks

In this order. Any failure refuses the file, and nothing has been written to the mirror yet (the one exception is the
CRC check during the copy, §6.3).

1. The file is at least 22 bytes long. The end of central directory record is searched backwards in the last
   22 + 65,535 + 20 bytes, so a comment of any length is found past.
2. When the 20 bytes before it are a zip64 locator, the zip64 end record it points at must lie before the end record and
   carry its signature; the entry count, the directory size and its offset are then taken from that record. A 64-bit
   value above 2^53 - 1 is refused.
3. The central directory ends before the end record and is at most 256 MiB.
4. Every central header has its signature and its lengths inside the directory. The name is UTF-8 when flag `0x0800` is
   set, else Latin-1. A zip64 extra field is read for the fields that are 0xFFFFFFFF (uncompressed size, compressed
   size, offset, in that order). **The method must be 0 and both sizes equal**: a compressed entry is refused.
5. Every local header lies before the central directory and has its signature; the data starts after the local
   header's own name and extra field and must end before the central directory. Sizes and CRCs come from the central
   directory, never from the local header.
6. The first central entry is `mimetype`: at most 256 bytes, its CRC correct, its content exactly
   `application/x-scumble`.
7. `scumble/document.json` is there, at most 64 MiB, its CRC correct, valid JSON.
8. The header rules (§6.2).
9. `Thumbnails/thumbnail.png`, when there is one: at most 16 MiB, CRC checked. A damaged thumbnail is a note, not a
   refusal (the app does not show it yet).
10. Every `files[]` item, before anything is written: its `entry` is a name the mirror takes (below); the entry is in the
    zip (a missing `required: false` entry is a note, "... of the result history is missing"; a missing required one
    refuses the file); its size equals `files[].size`.

**Entry names.** `files/<type>/<subfolder parts>/<filename>` with at least three parts; no empty, `.` or `..` part; `type`
one of `input`, `output`, `temp`; every subfolder part and the filename matching `SAFE_NAME`,
`/^[^\\/:*?"<>|\x00-\x1f]+$/` (the mirror's own rule, `electron/main/files.js`), not a name Windows maps to a device
(`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`, with any extension, any case) and not ending in a dot or a
space (Windows strips those). No absolute path, drive letter or backslash gets through, so a crafted file cannot write
outside the mirror or onto a device. Stored entries need no inflate, so there is no zip bomb.

**Refs the document does not carry.** Before anything is written, every ref in `document` (outside `history`), in
`plugins` and in `extra` must name a file `files[]` lists and the zip holds; one that does not refuses the open ("the
document names a file it does not carry"), so a crafted document cannot point at a file this profile's mirror holds
under that name and have a later save pack it. A result of the history whose file the document does not carry (not
listed, or listed as `required: false` and missing) leaves the history, with a note.

### 6.2 Header and version rules

| Case | What happens |
|---|---|
| `format` is not `"scumble"`, `version` is not an integer >= 1, `document` is not an object, `files` is not an array | refused |
| `minReader` (`version` when it is missing) above the reader's version (`READER_VERSION`, 1) | refused before anything is imported: "made by a newer Scumble ... update Scumble to open it" |
| `version` above `FORMAT_VERSION` (1), `minReader` within reach | opens with a note; the tab's file is marked `newer`, and a save in place asks first (*Save As / Overwrite / Cancel*) |
| otherwise | opens |

### 6.3 Files into the mirror

Every listed file, in `files[]` order, against its mirror path:

| The mirror has | Then |
|---|---|
| nothing under that name | the entry is copied to `<path>.importing-<pid>`, its CRC checked on the way, fsynced and renamed into place |
| a file of the same size and the same CRC-32 (the mirror file is read once for it) | reused, nothing is copied: a document reopened in the profile that saved it copies nothing |
| other bytes under that name | imported under a free name in the same folder (`photo.png` -> `photo (1).png`, then `(2)`, ...), and every ref to the old key in `document`, `plugins` and `extra` gets the new `filename` (same type and subfolder) |

A CRC mismatch during a copy stops the open and names the entry; the files imported before it stay in the mirror, valid,
for the clean-up to find. Progress goes to the window in bytes (`documents:progress { reqId, kind, done, total }`, at
most every 100 ms). After this the editor sees only refs to files that are in this mirror with the saved bytes (refs
the document does not carry were refused or left the history before, §6.1).

### 6.4 The state after reading

- **Selection fields** (`documents.cleanDocument`): a `selection` that is not a string starting with
  `data:image/png;base64,` is dropped together with `selectionBox`; the `selections` items whose `url` is not such a
  data URL are dropped, the rest reduced to `{ name, url }` (`name` "Selection" when it is not a string). Each drop is a
  note. Nothing else is loaded from those fields.
- **Unknown top-level fields of `document`** (not in `STATE_KEYS`), together with the fields of the header's `extra`
  that are not in `STATE_KEYS` either, become the tab's extra fields (`docExtra`): kept in the session autosave (and
  walked for refs, so the Local files clean-up keeps their files), and on the next save written back into `document`
  (the editor's own fields win) and into `extra`.
- **Unknown filter ids** are kept with their params: the filter passes the picture through (`applyFilter` returns its
  source), the layer panel shows "missing: <id>", and the next save writes the id and the params back unchanged.
- **Unknown layer kinds** with a `ref` load as pixel layers and keep their `kind`; a layer without a `ref` is dropped
  without a note (a `text` layer without one is rendered again from its description; a filter layer needs none).
- **Plugin data** of unknown plugins rides along (§5).
- **Not kept on the next save:** unknown fields at the top of `document.json` beside `document`, entries that `files[]`
  does not list, and unknown fields inside a layer, a history entry, a `selections` item, `match` or `guides` (the
  editor rebuilds those from its own field lists). Unknown keys inside `crop`, `upsample`, `gen`, `settings`, `refs`,
  `cutout`, `text`, a filter's `params`, `lut` and `plate` survive: they are merged over the defaults or kept as they
  are, and written back whole.
- **Values** go through what `setValue()` already clamps and defaults; filter params pass as they are.
- **The recipe** is not switched; the notes say when the document was saved with another one.

Where it lands: a path already open in a tab activates that tab (paths compared resolved, case-folded on Windows);
otherwise the active tab when it is empty, else a new tab. The state is restored like the session's (`host.restore()`),
and the tab counts as saved once its state's key has settled (`host.settleKey`, after the selection is encoded again).

## 7. Writing

### 7.1 In the window (`host.saveDocument`)

1. **The target:** the tab's file (Ctrl+S), or main's save dialog (Save As, or Ctrl+S on a tab without a file;
   `.scumble` is appended when missing). A save in place first compares the file's mtime (more than 1 ms apart) and size
   with what the tab recorded at the open or the last save and asks when they moved (*Overwrite / Save As / Cancel*);
   it also asks for a file a newer Scumble made (§6.2).
2. **The result history:** kept unless the caller says otherwise. A Save As of a document with results asks with three
   buttons (*Save with History / Save without History / Cancel*); the tab's file remembers "without" for the next
   Ctrl+S.
3. **The flush** (`host.flushEditor`): the edited layers and masks are uploaded to the mirror (up to three rounds, for a
   stroke that lands during one) and the selection's PNG is encoded. An upload that fails fails the save.
4. **The capture:** `getValue()`, the plugin data, the extra fields, the thumbnail (the composited picture at most
   256 px on its long side; none when it cannot be made), the summary and the recipe. A stroke after this point is not
   in the file and leaves the tab changed.
5. **The write** (`documents:write`, below). On success the tab's file becomes `{ path, name, key, mtime, size }`
   (`key` a 53-bit hash of the saved state string, which the dirty marker compares), unless the save was a copy.

One save per tab at a time. A failed or cancelled save keeps the tab's file as it was, so the tab stays changed.

### 7.2 In main (`documents.write`, `docfile.writeDocument`)

- **Checks:** the target is an absolute path ending in `.scumble`; the state has a `base`. One job per path at a time
  (a second save or an open of the same path is refused), keyed by the resolved path, case-folded on Windows.
- **`history: false`** empties `document.history` and `document.seen` (the prompts of earlier runs go with them; the
  current prompt stays).
- **The files:** every distinct ref (by mirror key) in `document` (the extra fields merged in) and `plugins`. A file
  missing from the mirror is fetched from ComfyUI's `/view` when ComfyUI is connected (the mirror keeps a copy). A
  required file that is still missing refuses the save ("... is not in the local store and ComfyUI could not send it;
  the document was not saved"); a file that only the result history names is left out together with its history
  entries, with a note.
- **The header** (§3) is built; above 64 MiB the save is refused.
- **Free space:** `statfs` of the target's folder must show the sum of the entry sizes (plus about 100 bytes and twice
  the name per entry) plus 1 MiB; the old file stays until the rename, so it does not count. Refused up front with
  `ENOSPC` otherwise; a `statfs` that fails skips the check.
- **The temporary file** `<target>.saving-<pid>-<n>` sits beside the target (a rename across volumes would fail) and is
  recorded in `<userData>/document-temps.json` before it is created. The entries are written as §2 says, the mirror
  files copied in 8 MiB chunks through `zlib.crc32`; a source whose size changed since it was listed fails the save
  ("... changed while it was saved").
- **fsync, close, rename** over the target. EPERM, EBUSY and EACCES (a virus scanner or a sync client holding the file)
  are retried 20 times, 100 ms apart; then the save fails with "... is in use by another program".
- **Any failure or a cancel** (checked between entries, between chunks and before the rename) closes the handle,
  deletes the temporary file and takes it off the list. The target is untouched.
- **The sweep:** at every start main deletes the files on the list that still match `.saving-<digits>-<digits>` (never
  any other file) and empties the list; `will-quit` does the same after it aborted a job. The close, an update install
  and *View › Reload* wait for the jobs in flight (inside the quit guard's 120 s); *Quit now* and a crashed window abort
  them. The mirror's clean-up is refused while a job runs, and keeps the files the jobs use.
- **The answer:** `{ path, name, bytes, entries, ms, mtime, size, notes }`; the path goes on *File › Open Recent*
  (not for a copy).

### 7.3 Another tool writing a file

A file Scumble opens needs `mimetype` as the first entry (stored, no extra field, flags 0, so the content sniff at
offset 0 works too), `scumble/document.json` with `format`, `version`, `minReader` and a `document` with a `base`, and a
`files[]` item with the exact size for every file a ref names; every entry stored. Refs use `type` `input`, `output` or
`temp` and names that pass the entry-name rule (§6.1), and every ref must name a file the document carries. Scumble
takes sizes and CRCs from the central directory, but a writer should still put them into the local headers and leave
out data descriptors, as Scumble does, so other readers take the file (`tools/document_test.js` checks Scumble's own
local headers).
Python's `zipfile` with `ZIP_STORED`, `mimetype` written first, is one way.

## 8. Versioning, for later writers

- `FORMAT_VERSION` in `docfile.js` is what the app writes as `version`, `READER_VERSION` the highest `minReader` it
  opens; the `minReader` it writes is the literal in `buildHeader`. The format of this file is 1 / 1.
- **Raise `version`** for an addition a v1 reader can carry without showing it and without harm: a new optional
  top-level field of `document` (it travels as an extra field), new plugin data, new keys inside `crop`, `gen`,
  `settings` and the other settings objects. A v1 reader opens such a file with a note and asks before saving over it.
- **Raise `minReader`** (and `READER_VERSION` in the app that understands it) when a v1 reader would show a different
  picture or lose what the document means. **A field that changes the picture raises `minReader`.** Examples:
  - a new layer field (clipping, a group, a fill opacity, a new blend mode): v1 shows the picture without it, and its
    next save drops unknown fields inside a layer, because `getValue()` rebuilds the layers from its own field list;
  - a layer kind without a `ref` (a group): v1 drops it; either raise `minReader` or give it a baked `ref`;
  - the selection or the saved selections moved into entries: v1 drops a selection that is not a PNG data URL;
  - a changed meaning of an existing field or filter parameter;
  - compressed entries (v1 refuses them) or files outside `files/` that the picture needs (v1 ignores them).
- **Nothing that must survive a v1 save goes at the top of `document.json`** beside `document`: v1 keeps only its own
  header fields. Put it into `document` (it travels as an extra field) or into plugin data.
- What a v1 reader keeps and loses is §6.4.

## 9. Differences from the plan

Where `docs/PLAN_DOCUMENTS.md` and the code differ, the code is what is described above:

1. **The result history question** is a message box with buttons after the save dialog (*Save with History / Save
   without History / Cancel*), not a switch in the Save As dialog: the native save dialog has no custom controls on
   Windows. The tab's file remembers "without" for the next Ctrl+S.
2. **Fonts and 3D models travel as ordinary refs** (`layers[].text.fontRef`, the glb plugin's `objects[id].ref`); there
   is no code of their own for them. Bundled and system fonts travel by name only.
3. **`saved`** is UTC (`toISOString()`, `...Z`), not a local time with its offset.
4. **The zip64 thresholds** are "reaches" (a size or offset >= 0xFFFFFFFF, an entry count >= 0xFFFF), not "passes" and
   "more than 65,535".
5. **No check of the written file.** The plan's §4.1 had main verify the central directory against `files[]` after the
   write; the writer does not. Its answer is `{ path, name, bytes, entries, ms, mtime, size, notes }`, not
   `{ path, bytes, files, ms }`.
6. **A layer of an unknown kind without a `ref`** is dropped without a note (plan §6: "with a note").
7. **The selection in entries is not readable by v1.** Plan §3.3 says the v1 reader "already accepts both" (data URLs
   and entries); `cleanDocument` drops a selection that is not a PNG data URL, so moving the selections into entries
   needs a `minReader` raise (§8).
8. **The extra fields are written twice:** back into `document` (as the plan says) and again as `extra` in the header.
   Unknown fields at the top of `document.json` itself are not kept (the plan covers only `document`'s).
9. **Small additions the plan did not name:** a missing `minReader` counts as `version`; the thumbnail is read up to
   16 MiB and a damaged one is only a note; the free-space sum adds about 100 bytes and twice the name per entry; the
   "changed on disk" test allows 1 ms of mtime difference.
